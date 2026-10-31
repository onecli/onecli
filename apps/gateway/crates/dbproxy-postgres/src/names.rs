//! The server's prepared statements, as the gateway tracks them.
//!
//! Running a prepared statement sends no SQL, so the gateway judges it by
//! what its name holds. That is only sound while the gateway's map of names
//! matches the server's, so the map follows the server's own rules:
//!
//! - a name is keyed the way the server keys it: its first 63 bytes
//!   (`NAMEDATALEN - 1`), cut bytewise, so two names sharing those bytes are
//!   one statement;
//! - a change is applied as it is sent, so the messages after it see it (the
//!   server runs messages in order, and after an error skips the rest up to
//!   the batch's `Sync`, or the rest of a simple query);
//! - the server confirms each change in order (`ParseComplete`,
//!   `CloseComplete`, or the command tag of `PREPARE` / `DEALLOCATE`). An
//!   error before a change's confirmation means the server never made it, so
//!   it is taken back. A change the server answered neither way by its
//!   `ReadyForQuery` leaves its name judged by the stricter of the two
//!   states it could be in.
//!
//! Prepared statements outlive transactions; portals do not. Running more
//! of a portal (`Execute`, SQL `FETCH`) runs only what was judged when it was
//! made: `Bind` is judged by its statement, `DECLARE` by its query, and a
//! cursor a function opens by the call that opened it. The one exception is
//! a statement that runs another by name (`EXECUTE name`, which only the
//! extended protocol can prepare): the server looks the name up each time
//! the portal runs. Such a statement may only be bound to the unnamed portal,
//! which SQL cannot name, and every `Execute` of it is judged again.

use std::collections::{HashMap, VecDeque};

use dbproxy::statement::{Classified, StatementClass};

use crate::reason;
use crate::tokens::MAX_IDENTIFIER_BYTES;

/// The most memory a session's tracked statements may take (their names and
/// audit text, plus [`ENTRY_BYTES`] each). Drivers that cache statements
/// hold a few hundred; past the budget, preparing another is refused, since
/// a statement the gateway did not track would be judged blind.
pub const MAX_PREPARED_BYTES: usize = 2 * 1024 * 1024;

/// What one tracked statement costs beyond its name and audit text.
const ENTRY_BYTES: usize = 64;

/// How many statements deep a chain of `EXECUTE`s is followed; the server
/// itself gives up on a cycle only when its stack runs out.
const MAX_EXECUTE_DEPTH: usize = 8;

/// A name as the server keys its prepared statements and portals.
pub type Key = Vec<u8>;

/// The key for `name`: its first 63 bytes. SQL names arrive already cut by
/// the lexer (on a character boundary); protocol messages carry them whole,
/// and the server's table cuts those bytewise.
#[must_use]
pub fn key(name: &[u8]) -> Key {
    name[..name.len().min(MAX_IDENTIFIER_BYTES)].to_vec()
}

/// What a prepared statement runs, as the gateway judged it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    /// What its own text does.
    pub classified: Classified,
    pub audit: String,
    /// The statement it runs by name (`EXECUTE name`), looked up each time
    /// it runs.
    pub executes: Option<Key>,
}

impl Prepared {
    /// A statement whose text alone decides what it runs.
    #[must_use]
    pub fn new(classified: Classified, audit: String) -> Self {
        Self {
            classified,
            audit,
            executes: None,
        }
    }

    /// A statement the gateway never saw prepared: one made out of its view
    /// (inside a function) runs as at least a write.
    #[must_use]
    pub fn unseen(name: &[u8]) -> Self {
        Self::new(
            Classified::Judged(StatementClass::Write),
            format!("EXECUTE {}", String::from_utf8_lossy(name)),
        )
    }

    fn cost(&self, name: &[u8]) -> usize {
        ENTRY_BYTES + name.len() + self.audit.len() + self.executes.as_ref().map_or(0, Vec::len)
    }
}

/// How a change reaches the server, which decides how the server confirms it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    /// A protocol message (`Parse`, `Close`).
    Message,
    /// A SQL statement (`PREPARE`, `DEALLOCATE`, `DISCARD ALL`).
    Sql,
}

/// One change a unit makes to the server's prepared statements.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Prepare(Key, Prepared),
    Deallocate(Key),
    DeallocateAll,
    /// A protocol `Close` of a portal: changes no statement, but the server
    /// confirms it like a statement's `Close`, so it holds its place in line.
    ClosePortal,
}

impl Change {
    /// Whether the server message `tag` (with `command`, a
    /// `CommandComplete`'s tag) confirms this change.
    fn confirmed_by(&self, via: Via, tag: u8, command: &[u8]) -> bool {
        match via {
            Via::Message => match self {
                Self::Prepare(..) => tag == b'1',
                Self::Deallocate(_) | Self::ClosePortal => tag == b'3',
                Self::DeallocateAll => false,
            },
            Via::Sql => {
                tag == b'C'
                    && match self {
                        Self::Prepare(..) => command == b"PREPARE",
                        Self::Deallocate(_) => command == b"DEALLOCATE",
                        Self::DeallocateAll => {
                            command == b"DEALLOCATE ALL" || command == b"DISCARD ALL"
                        }
                        Self::ClosePortal => false,
                    }
            }
        }
    }
}

/// A change sent but not yet confirmed, with what it replaced.
struct Unconfirmed {
    change: Change,
    via: Via,
    before: Before,
}

enum Before {
    Statement(Key, Option<Prepared>),
    Statements(HashMap<Key, Prepared>),
    Nothing,
}

/// The session's map of the server's prepared statements.
#[derive(Default)]
pub struct Names {
    statements: HashMap<Key, Prepared>,
    /// What [`Self::statements`] costs against [`MAX_PREPARED_BYTES`].
    statement_bytes: usize,
    /// The statement the unnamed portal runs, when it runs another by name
    /// and so must be judged again each time it runs.
    unnamed_portal: Option<Prepared>,
    /// Changes sent but not yet confirmed, oldest first. Only ever spans the
    /// messages sent since the server last reported ready.
    unconfirmed: VecDeque<Unconfirmed>,
}

impl Names {
    fn put(&mut self, name: Key, prepared: Prepared) -> Option<Prepared> {
        self.statement_bytes += prepared.cost(&name);
        let before = self.take(&name);
        self.statements.insert(name, prepared);
        before
    }

    fn take(&mut self, name: &[u8]) -> Option<Prepared> {
        let taken = self.statements.remove(name)?;
        self.statement_bytes -= taken.cost(name);
        Some(taken)
    }

    /// Apply a unit's changes as it is sent to the server.
    pub fn send(&mut self, sent: Sent) {
        if let Some(portal) = sent.unnamed_portal {
            self.unnamed_portal = portal;
        }
        for (change, via) in sent.changes {
            let before = match &change {
                Change::Prepare(name, prepared) => {
                    Before::Statement(name.clone(), self.put(name.clone(), prepared.clone()))
                }
                Change::Deallocate(name) => Before::Statement(name.clone(), self.take(name)),
                Change::DeallocateAll => {
                    self.statement_bytes = 0;
                    Before::Statements(std::mem::take(&mut self.statements))
                }
                Change::ClosePortal => Before::Nothing,
            };
            self.unconfirmed.push_back(Unconfirmed {
                change,
                via,
                before,
            });
        }
    }

    /// Take in one message from the server, by its type `tag` and `body`.
    pub fn observe(&mut self, tag: u8, body: &[u8]) {
        match tag {
            b'1' | b'3' | b'C' => {
                let command = if tag == b'C' {
                    body.split(|&b| b == 0).next().unwrap_or_default()
                } else {
                    &[]
                };
                if self
                    .unconfirmed
                    .front()
                    .is_some_and(|u| u.change.confirmed_by(u.via, tag, command))
                {
                    self.unconfirmed.pop_front();
                }
            }
            // The failed message changed nothing, and the server skips every
            // later one up to the batch's end: take them all back, newest
            // first.
            b'E' => {
                while let Some(unconfirmed) = self.unconfirmed.pop_back() {
                    match unconfirmed.before {
                        Before::Statement(name, Some(prepared)) => {
                            self.put(name, prepared);
                        }
                        Before::Statement(name, None) => {
                            self.take(&name);
                        }
                        Before::Statements(all) => {
                            for (name, prepared) in all {
                                self.put(name, prepared);
                            }
                        }
                        Before::Nothing => {}
                    }
                }
            }
            b'Z' => self.settle(body.first() == Some(&b'I')),
            _ => {}
        }
    }

    /// Everything sent so far has finished. A change the server answered
    /// neither way may or may not have happened.
    fn settle(&mut self, idle: bool) {
        while let Some(Unconfirmed { before, .. }) = self.unconfirmed.pop_front() {
            match before {
                Before::Statement(name, before) => self.uncertain(name, before),
                Before::Statements(all) => {
                    for (name, before) in all {
                        self.uncertain(name, Some(before));
                    }
                }
                Before::Nothing => {}
            }
        }
        // A transaction that ended took its portals with it.
        if idle {
            self.unnamed_portal = None;
        }
    }

    /// Judge `name` by the stricter of the two states the server may hold.
    fn uncertain(&mut self, name: Key, before: Option<Prepared>) {
        let after = self.take(&name).unwrap_or_else(|| Prepared::unseen(&name));
        let before = before.unwrap_or_else(|| Prepared::unseen(&name));
        let executes = after.executes.or(before.executes);
        let classified = after.classified.combine(before.classified);
        self.put(
            name,
            Prepared {
                classified,
                audit: after.audit,
                executes,
            },
        );
    }
}

/// A unit's changes, ready to apply as it is sent.
pub struct Sent {
    changes: Vec<(Change, Via)>,
    /// `Some` when the unit binds the unnamed portal.
    unnamed_portal: Option<Option<Prepared>>,
}

/// One unit's changes while it is judged: its later messages see them at
/// once, before anything is sent.
pub struct Draft<'a> {
    names: &'a Names,
    /// `None`: deallocated in this unit.
    statements: HashMap<Key, Option<Prepared>>,
    all_deallocated: bool,
    unnamed_portal: Option<Option<Prepared>>,
    added_bytes: usize,
    changes: Vec<(Change, Via)>,
}

impl<'a> Draft<'a> {
    #[must_use]
    pub fn new(names: &'a Names) -> Self {
        Self {
            names,
            statements: HashMap::new(),
            all_deallocated: false,
            unnamed_portal: None,
            added_bytes: 0,
            changes: Vec::new(),
        }
    }

    /// The statement keyed `name` at this point of the unit.
    #[must_use]
    pub fn statement(&self, name: &[u8]) -> Prepared {
        let name = key(name);
        let current = match self.statements.get(&name) {
            Some(current) => current.as_ref(),
            None if self.all_deallocated => None,
            None => self.names.statements.get(&name),
        };
        current.cloned().unwrap_or_else(|| Prepared::unseen(&name))
    }

    /// What running `prepared` does now, following the statements it runs
    /// by name.
    #[must_use]
    pub fn runs(&self, prepared: &Prepared) -> Classified {
        let mut classified = prepared.classified.clone();
        let mut next = prepared.executes.clone();
        for _ in 0..MAX_EXECUTE_DEPTH {
            let Some(name) = next else {
                return classified;
            };
            let executed = self.statement(&name);
            classified = classified.combine(executed.classified);
            next = executed.executes;
        }
        if next.is_some() {
            classified = classified.combine(Classified::Forbidden(reason::UNCHECKABLE));
        }
        classified
    }

    /// What running statement `name` does now.
    #[must_use]
    pub fn runs_statement(&self, name: &[u8]) -> Classified {
        self.runs(&self.statement(name))
    }

    /// `Bind` of statement `statement` to `portal`: the verdict for running
    /// the portal, which is the statement's.
    pub fn bind(&mut self, portal: &[u8], statement: &[u8]) -> (Classified, String) {
        let prepared = self.statement(statement);
        let classified = self.runs(&prepared);
        let late_bound = prepared.executes.is_some();
        if portal.is_empty() {
            self.unnamed_portal = Some(late_bound.then(|| prepared.clone()));
        } else if late_bound {
            return (
                Classified::Forbidden(reason::NAMED_PORTAL_EXECUTE),
                prepared.audit,
            );
        }
        (classified, prepared.audit)
    }

    /// `Execute` of `portal`: running more of it runs only what its `Bind`
    /// was judged for, unless it runs a statement by name, which the server
    /// looks up again now.
    #[must_use]
    pub fn execute(&self, portal: &[u8]) -> Classified {
        let bound = match &self.unnamed_portal {
            Some(bound) => bound.as_ref(),
            None => self.names.unnamed_portal.as_ref(),
        };
        match bound.filter(|_| portal.is_empty()) {
            Some(prepared) => self.runs(prepared),
            None => Classified::Housekeeping,
        }
    }

    /// Prepare `name`, unless the session's statements would exceed
    /// [`MAX_PREPARED_BYTES`].
    pub fn prepare(
        &mut self,
        name: &[u8],
        prepared: Prepared,
        via: Via,
    ) -> Result<(), &'static str> {
        let name = key(name);
        let cost = prepared.cost(&name);
        if self.names.statement_bytes + self.added_bytes + cost > MAX_PREPARED_BYTES {
            return Err(reason::TOO_MANY_PREPARED);
        }
        self.added_bytes += cost;
        self.statements.insert(name.clone(), Some(prepared.clone()));
        self.changes.push((Change::Prepare(name, prepared), via));
        Ok(())
    }

    pub fn deallocate(&mut self, name: &[u8], via: Via) {
        let name = key(name);
        self.statements.insert(name.clone(), None);
        self.changes.push((Change::Deallocate(name), via));
    }

    /// `DEALLOCATE ALL` / `DISCARD ALL`.
    pub fn deallocate_all(&mut self) {
        self.statements.clear();
        self.all_deallocated = true;
        self.changes.push((Change::DeallocateAll, Via::Sql));
    }

    /// A protocol `Close` of a portal.
    pub fn close_portal(&mut self) {
        self.changes.push((Change::ClosePortal, Via::Message));
    }

    /// The changes, in message order, to apply as the unit is sent.
    #[must_use]
    pub fn finish(self) -> Sent {
        Sent {
            changes: self.changes,
            unnamed_portal: self.unnamed_portal,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use StatementClass::{Read, Schema, Write};

    fn judged(class: StatementClass) -> Prepared {
        Prepared::new(Classified::Judged(class), String::new())
    }

    /// `EXECUTE target`, prepared through the protocol.
    fn executing(target: &[u8]) -> Prepared {
        Prepared {
            executes: Some(key(target)),
            ..judged(Read)
        }
    }

    fn send(names: &mut Names, change: Change, via: Via) {
        names.send(Sent {
            changes: vec![(change, via)],
            unnamed_portal: None,
        });
    }

    fn class_of(names: &Names, name: &[u8]) -> Classified {
        Draft::new(names).runs_statement(name)
    }

    const IDLE: &[u8] = b"I";

    #[test]
    fn a_confirmed_change_stays() {
        let mut names = Names::default();
        send(
            &mut names,
            Change::Prepare(key(b"s"), judged(Write)),
            Via::Message,
        );
        names.observe(b'1', &[]);
        names.observe(b'E', &[]);
        assert_eq!(class_of(&names, b"s"), Classified::Judged(Write));
    }

    /// The server refuses to prepare a name that exists; the name keeps the
    /// statement it had, whatever the refused one would have run.
    #[test]
    fn a_change_the_server_refused_is_taken_back() {
        let mut names = Names::default();
        send(
            &mut names,
            Change::Prepare(key(b"s"), judged(Write)),
            Via::Message,
        );
        names.observe(b'1', &[]);
        names.observe(b'Z', IDLE);
        send(
            &mut names,
            Change::Prepare(key(b"s"), judged(Read)),
            Via::Message,
        );
        names.observe(b'E', &[]);
        names.observe(b'Z', IDLE);
        assert_eq!(class_of(&names, b"s"), Classified::Judged(Write));
    }

    /// Everything after a failed message is skipped up to the batch's end,
    /// so every later change in it is taken back too.
    #[test]
    fn an_error_takes_back_every_later_change_in_the_batch() {
        let mut names = Names::default();
        names.send(Sent {
            changes: vec![
                (Change::Prepare(key(b"a"), judged(Read)), Via::Message),
                (Change::DeallocateAll, Via::Sql),
                (Change::Prepare(key(b"b"), judged(Read)), Via::Message),
            ],
            unnamed_portal: None,
        });
        names.observe(b'1', &[]);
        names.observe(b'E', &[]);
        assert_eq!(
            class_of(&names, b"a"),
            Classified::Judged(Read),
            "confirmed"
        );
        assert_eq!(
            class_of(&names, b"b"),
            Classified::Judged(Write),
            "never made"
        );
        assert_eq!(names.statement_bytes, judged(Read).cost(b"a"));
    }

    /// Confirmations are matched in order: a portal's `CloseComplete` does
    /// not confirm the statement `Close` behind it.
    #[test]
    fn confirmations_match_in_order() {
        let mut names = Names::default();
        send(
            &mut names,
            Change::Prepare(key(b"s"), judged(Schema)),
            Via::Message,
        );
        names.observe(b'1', &[]);
        names.send(Sent {
            changes: vec![
                (Change::ClosePortal, Via::Message),
                (Change::Deallocate(key(b"s")), Via::Message),
                (Change::Prepare(key(b"s"), judged(Read)), Via::Message),
            ],
            unnamed_portal: None,
        });
        names.observe(b'3', &[]);
        names.observe(b'E', &[]);
        assert_eq!(class_of(&names, b"s"), Classified::Judged(Schema));
    }

    /// SQL-level changes are confirmed by their command tags.
    #[test]
    fn sql_changes_are_confirmed_by_their_command_tags() {
        let mut names = Names::default();
        names.send(Sent {
            changes: vec![
                (Change::Prepare(key(b"a"), judged(Read)), Via::Sql),
                (Change::Prepare(key(b"b"), judged(Read)), Via::Sql),
            ],
            unnamed_portal: None,
        });
        names.observe(b'C', b"PREPARE\0");
        names.observe(b'C', b"SELECT 1\0");
        names.observe(b'E', &[]);
        assert_eq!(class_of(&names, b"a"), Classified::Judged(Read));
        assert_eq!(class_of(&names, b"b"), Classified::Judged(Write));

        send(&mut names, Change::DeallocateAll, Via::Sql);
        names.observe(b'C', b"DISCARD ALL\0");
        names.observe(b'E', &[]);
        assert_eq!(class_of(&names, b"a"), Classified::Judged(Write), "gone");
        assert_eq!(names.statement_bytes, 0);
    }

    /// A change left unanswered by ready may or may not have happened.
    #[test]
    fn an_unanswered_change_is_judged_by_the_stricter_state() {
        let mut names = Names::default();
        send(
            &mut names,
            Change::Prepare(key(b"s"), judged(Schema)),
            Via::Sql,
        );
        names.observe(b'C', b"PREPARE\0");
        send(&mut names, Change::Deallocate(key(b"s")), Via::Sql);
        send(
            &mut names,
            Change::Prepare(key(b"s"), judged(Read)),
            Via::Sql,
        );
        names.observe(b'Z', IDLE);
        assert_eq!(class_of(&names, b"s"), Classified::Judged(Schema));

        // A name never seen may hold a statement made out of view.
        let mut names = Names::default();
        send(
            &mut names,
            Change::Prepare(key(b"t"), judged(Read)),
            Via::Message,
        );
        names.observe(b'Z', IDLE);
        assert_eq!(class_of(&names, b"t"), Classified::Judged(Write));
    }

    /// The server keys names by their first 63 bytes, cut bytewise.
    #[test]
    fn names_are_keyed_by_their_first_63_bytes() {
        let mut names = Names::default();
        let mut draft = Draft::new(&names);
        let long = format!("{}A", "x".repeat(63));
        draft
            .prepare(long.as_bytes(), judged(Write), Via::Message)
            .unwrap();
        names.send(draft.finish());
        names.observe(b'1', &[]);
        for alias in ["x".repeat(63), format!("{}B", "x".repeat(63))] {
            assert_eq!(
                class_of(&names, alias.as_bytes()),
                Classified::Judged(Write),
                "{alias}"
            );
        }
        // A two-byte character straddling byte 63 is cut in half, as the
        // server's table cuts it.
        let e_acute = format!("{}é", "a".repeat(62));
        let e_grave = format!("{}è", "a".repeat(62));
        assert_eq!(key(e_acute.as_bytes()), key(e_grave.as_bytes()));
        assert_ne!(key(e_acute.as_bytes()), key("a".repeat(62).as_bytes()));
    }

    #[test]
    fn a_draft_sees_its_own_changes_in_order() {
        let mut names = Names::default();
        send(
            &mut names,
            Change::Prepare(key(b"s"), judged(Read)),
            Via::Sql,
        );
        names.observe(b'C', b"PREPARE\0");
        let mut draft = Draft::new(&names);
        assert_eq!(draft.runs_statement(b"s"), Classified::Judged(Read));
        draft.deallocate(b"s", Via::Sql);
        assert_eq!(draft.runs_statement(b"s"), Classified::Judged(Write));
        draft.prepare(b"s", judged(Schema), Via::Sql).unwrap();
        assert_eq!(draft.runs_statement(b"s"), Classified::Judged(Schema));
        draft.deallocate_all();
        assert_eq!(draft.runs_statement(b"s"), Classified::Judged(Write));
    }

    /// `EXECUTE name` inside a protocol statement runs whatever the name
    /// holds when it runs, not when it was prepared.
    #[test]
    fn a_statement_that_executes_another_is_judged_when_it_runs() {
        let mut names = Names::default();
        let mut draft = Draft::new(&names);
        draft.prepare(b"target", judged(Read), Via::Sql).unwrap();
        draft
            .prepare(b"outer", executing(b"target"), Via::Message)
            .unwrap();
        assert_eq!(draft.runs_statement(b"outer"), Classified::Judged(Read));
        // Swapping the target swaps what `outer` runs.
        draft.deallocate(b"target", Via::Sql);
        draft.prepare(b"target", judged(Schema), Via::Sql).unwrap();
        assert_eq!(draft.runs_statement(b"outer"), Classified::Judged(Schema));
        names.send(draft.finish());

        // So does the unnamed portal bound to it, at every Execute.
        let mut draft = Draft::new(&names);
        draft.deallocate(b"target", Via::Sql);
        draft.prepare(b"target", judged(Read), Via::Sql).unwrap();
        let (bound, _) = draft.bind(b"", b"outer");
        assert_eq!(bound, Classified::Judged(Read));
        names.send(draft.finish());
        let mut draft = Draft::new(&names);
        draft.deallocate(b"target", Via::Sql);
        draft.prepare(b"target", judged(Write), Via::Sql).unwrap();
        assert_eq!(draft.execute(b""), Classified::Judged(Write));
        assert_eq!(draft.execute(b"named"), Classified::Housekeeping);

        // A named portal could be fetched by SQL, which the gateway does not
        // follow: refused.
        let mut draft = Draft::new(&names);
        assert_eq!(
            draft.bind(b"named", b"outer").0,
            Classified::Forbidden(reason::NAMED_PORTAL_EXECUTE)
        );
        // An ordinary statement binds anywhere, and its portal reads on.
        draft
            .prepare(b"plain", judged(Write), Via::Message)
            .unwrap();
        assert_eq!(draft.bind(b"named", b"plain").0, Classified::Judged(Write));
        assert_eq!(draft.bind(b"", b"plain").0, Classified::Judged(Write));
        assert_eq!(draft.execute(b""), Classified::Housekeeping);
    }

    #[test]
    fn the_unnamed_portal_ends_with_its_transaction() {
        let mut names = Names::default();
        let mut draft = Draft::new(&names);
        draft
            .prepare(b"outer", executing(b"target"), Via::Message)
            .unwrap();
        draft.bind(b"", b"outer");
        names.send(draft.finish());
        names.observe(b'Z', b"T");
        assert_eq!(
            Draft::new(&names).execute(b""),
            Classified::Judged(Write),
            "the unseen target"
        );
        names.observe(b'Z', IDLE);
        assert_eq!(Draft::new(&names).execute(b""), Classified::Housekeeping);
    }

    #[test]
    fn execute_cycles_are_refused() {
        let mut names = Names::default();
        let mut draft = Draft::new(&names);
        draft.prepare(b"a", executing(b"b"), Via::Message).unwrap();
        draft.prepare(b"b", executing(b"a"), Via::Message).unwrap();
        names.send(draft.finish());
        assert_eq!(
            class_of(&names, b"a"),
            Classified::Forbidden(reason::UNCHECKABLE)
        );
    }

    #[test]
    fn tracked_statements_have_a_memory_budget() {
        let mut names = Names::default();
        let big = Prepared::new(Classified::Judged(Read), "x".repeat(MAX_PREPARED_BYTES / 2));
        let mut draft = Draft::new(&names);
        draft.prepare(b"a", big.clone(), Via::Message).unwrap();
        assert_eq!(
            draft.prepare(b"b", big.clone(), Via::Message),
            Err(reason::TOO_MANY_PREPARED),
            "the draft counts its own"
        );
        names.send(draft.finish());
        names.observe(b'1', &[]);
        assert_eq!(
            Draft::new(&names).prepare(b"b", big, Via::Message),
            Err(reason::TOO_MANY_PREPARED)
        );
        send(&mut names, Change::Deallocate(key(b"a")), Via::Message);
        names.observe(b'3', &[]);
        assert_eq!(names.statement_bytes, 0, "freed with the statement");
    }
}
