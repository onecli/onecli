//! One agent session: every unit of work judged, then relayed.
//!
//! A **unit** is what the server runs as one: a simple `Query`, or the
//! extended-protocol messages up to a `Sync`. The gateway reads a whole unit
//! from the agent, judges it through [`dbproxy::gate`], and only then sends
//! any of it to the server, so a refused unit never partly runs. Results flow
//! straight back while the gateway watches for the unit's `ReadyForQuery`,
//! which carries the transaction status a refusal must report.
//!
//! Extended-protocol messages are judged by the SQL that will run:
//!
//! - `Parse` is classified when it arrives and remembered by statement name;
//!   preparing runs nothing, so only a statement refused outright is refused
//!   at `Parse`;
//! - `Bind` creates a portal that runs its statement, possibly in parts
//!   (`Execute` with a row limit, or SQL `FETCH`), so `Bind` is judged by
//!   what the statement runs, and running more of a portal is not judged
//!   again (see [`crate::names`] for the one exception);
//! - `Describe`, `Close` and `Flush` run nothing;
//! - `FunctionCall` has no SQL to check and is refused.
//!
//! SQL-level `PREPARE` / `EXECUTE` / `DEALLOCATE` share the server's
//! namespace with the protocol's; [`crate::names`] tracks both, kept in step
//! by the server's own answers.
//!
//! Before each unit the session's grants are re-read through the connect
//! cache, so a connection switched off for the agent, a changed rule, or a
//! deleted agent reaches sessions already open, as it reaches HTTP traffic.
//!
//! A unit holding `COPY ... FROM STDIN` is followed by the agent's data; the
//! gateway relays it until `CopyDone` / `CopyFail` without judging rows.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use context::PolicyEngine;
use dbproxy::gate::{Gate, RefusalKind, Unit, Verdict};
use dbproxy::limits::{IDLE_TIMEOUT, MAX_UNIT_BYTES};
use dbproxy::login::{self, LoginError};
use dbproxy::parse_pool::ParsePool;
use dbproxy::statement::Classified;

use crate::classify::{self, Analysis, Effect};
use crate::client::ClientStream;
use crate::front_door::ENGINE;
use crate::names::{self, Draft, Names, Prepared, Sent, Via};
use crate::reason;
use crate::server::ServerStream;
use crate::wire::{self, Frame, FrameReader, Reader, TxStatus};

/// The most messages one unit may hold before its `Sync`.
const MAX_UNIT_MESSAGES: usize = 10_000;

/// How long a session may sit between units before the gateway closes it.
/// The idle limit applies only while no unit is running: a long query or an
/// approval wait never counts against it.
const IDLE: Duration = IDLE_TIMEOUT;

/// Everything a session needs beyond its two streams.
pub struct Session<'a> {
    pub gate: Gate<'a>,
    pub policy_engine: &'a PolicyEngine,
    pub parse_pool: &'a ParsePool,
    pub client: FrameReader<ClientStream>,
    pub server: FrameReader<ServerStream>,
}

/// One unit as judged: the frames to send, its verdict, and its audit text.
struct Judged {
    frames: Vec<Frame>,
    classified: Classified,
    audit: String,
    /// Changes to the server's prepared statements, applied as it is sent.
    sent: Sent,
    /// Whether the unit ends in a `Sync` (or is a simple query), so the
    /// server answers with `ReadyForQuery`.
    synced: bool,
}

impl Session<'_> {
    /// Run the session until either side closes.
    pub async fn run(mut self) -> Result<()> {
        let mut names = Names::default();
        let mut status = TxStatus::Idle;
        let mut shutdown = shutdown::subscribe();
        // The unit being read. It lives outside the wait below so a frame
        // read before another branch wins is never lost: each branch reads at
        // most one whole frame, which the readers keep whole across a
        // cancelled read.
        let mut unit = UnitBuffer::default();
        loop {
            let idle = unit.is_empty();
            tokio::select! {
                frame = self.client.next() => match frame? {
                    Some(frame) => {
                        if !unit.push(frame)? {
                            continue;
                        }
                    }
                    None if unit.is_empty() => return Ok(()),
                    None => bail!("the client closed the connection mid-unit"),
                },
                // A unit in progress always completes; only a quiet session
                // times out or yields to a restart.
                () = tokio::time::sleep(IDLE), if idle => {
                    self.say_goodbye("57P05", "the session was idle for too long and OneCLI closed it").await;
                    return Ok(());
                }
                () = shutdown.wait(), if idle => {
                    self.say_goodbye("57P01", "the OneCLI gateway is restarting; reconnect").await;
                    return Ok(());
                }
                // A server that speaks between units (a notification, the
                // answers to a Flush-ended unit) is relayed; one that closes
                // ends it.
                frame = self.server.next() => {
                    match frame? {
                        Some(frame) => {
                            names.observe(frame.tag(), &frame.body());
                            wire::write_frames(self.client.stream(), [&frame]).await?;
                            continue;
                        }
                        None => return Ok(()),
                    }
                }
            }
            let frames = unit.take();
            if frames.last().map(Frame::tag) == Some(b'X') {
                // Terminate: pass it on so the server ends cleanly.
                let _ = wire::write_frames(self.server.stream(), &frames).await;
                return Ok(());
            }
            let judged = judge(self.parse_pool, frames, &names).await;
            match self.refresh().await {
                Ok(()) => status = self.run_unit(judged, &mut names, status).await?,
                Err(error @ LoginError::Unavailable) => {
                    self.refuse(judged.synced, status, "57P03", &error.to_string())
                        .await?;
                }
                Err(revoked) => {
                    self.say_goodbye("28000", &revoked.to_string()).await;
                    return Ok(());
                }
            }
        }
    }

    /// Re-read the session's grants through the connect cache.
    async fn refresh(&mut self) -> Result<(), LoginError> {
        self.gate.resolved = login::refresh(
            self.gate.login,
            &ENGINE,
            self.policy_engine,
            self.gate.cache,
        )
        .await?;
        Ok(())
    }

    /// Judge, then run or refuse one unit. Returns the transaction status
    /// after it.
    async fn run_unit(
        &mut self,
        judged: Judged,
        names: &mut Names,
        status: TxStatus,
    ) -> Result<TxStatus> {
        let unit = Unit {
            classified: judged.classified.clone(),
            normalized: &judged.audit,
        };
        let admitted = match self.gate.judge(&unit).await {
            Verdict::Run(admitted) => admitted,
            Verdict::Refuse(refusal) => {
                let sqlstate = match refusal.kind {
                    RefusalKind::Invalid => "42601",
                    RefusalKind::RateLimited => "53400",
                    RefusalKind::Unavailable => "57P03",
                    RefusalKind::Denied | RefusalKind::NotApproved => "42501",
                };
                self.refuse(judged.synced, status, sqlstate, &refusal.message)
                    .await?;
                return Ok(status);
            }
        };
        names.send(judged.sent);
        wire::write_frames(self.server.stream(), &judged.frames).await?;
        let (succeeded, new_status) = if judged.synced {
            self.relay_until_ready(names).await?
        } else {
            // Flush-driven pipelines get their answers without a Sync; the
            // session loop relays them as they come.
            (true, status)
        };
        admitted.finish(succeeded);
        Ok(new_status)
    }

    /// Answer a unit that is not sent: its error, then (when the client is
    /// waiting for one) the unchanged transaction status. Inside a
    /// transaction the server would have aborted it; the gateway leaves the
    /// server's state as it was, so the client's next statement runs
    /// normally.
    async fn refuse(
        &mut self,
        synced: bool,
        status: TxStatus,
        sqlstate: &str,
        message: &str,
    ) -> Result<()> {
        let error = wire::error_response("ERROR", sqlstate, message, None);
        if synced {
            wire::write_frames(
                self.client.stream(),
                [&error, &wire::ready_for_query(status)],
            )
            .await?;
        } else {
            wire::write_frames(self.client.stream(), [&error]).await?;
            // The client sent no Sync yet: discard until it does, as the
            // server would after an error.
            self.discard_until_sync().await?;
            wire::write_frames(self.client.stream(), [&wire::ready_for_query(status)]).await?;
        }
        Ok(())
    }

    /// Relay the server's answers to the client until `ReadyForQuery`,
    /// keeping `names` in step with what the server confirms. Returns
    /// whether the unit ran without an error, and the transaction status it
    /// left.
    async fn relay_until_ready(&mut self, names: &mut Names) -> Result<(bool, TxStatus)> {
        let mut succeeded = true;
        let mut batch: Vec<Frame> = Vec::new();
        loop {
            let frame = self
                .server
                .next()
                .await?
                .context("the database server closed the connection")?;
            let tag = frame.tag();
            names.observe(tag, &frame.body());
            match tag {
                b'E' => succeeded = false,
                // CopyInResponse: the client sends data next. Relay what is
                // pending, then the client's copy stream.
                b'G' => {
                    batch.push(frame);
                    wire::write_frames(self.client.stream(), batch.drain(..).as_slice()).await?;
                    self.relay_copy_in().await?;
                    continue;
                }
                b'Z' => {
                    let status = frame
                        .body()
                        .first()
                        .copied()
                        .and_then(TxStatus::from_byte)
                        .context("ReadyForQuery without a status")?;
                    batch.push(frame);
                    wire::write_frames(self.client.stream(), &batch).await?;
                    return Ok((succeeded, status));
                }
                _ => {}
            }
            batch.push(frame);
            // Stream large results instead of holding them.
            if batch.len() >= 256 || !self.server.has_frame() {
                wire::write_frames(self.client.stream(), batch.drain(..).as_slice()).await?;
            }
        }
    }

    /// Relay `CopyData` from the client until `CopyDone` or `CopyFail`.
    async fn relay_copy_in(&mut self) -> Result<()> {
        loop {
            let frame = self
                .client
                .next()
                .await?
                .context("the client closed the connection during COPY")?;
            let tag = frame.tag();
            match tag {
                b'd' | b'c' | b'f' | b'H' | b'S' => {
                    wire::write_frames(self.server.stream(), [&frame]).await?;
                }
                _ => bail!("unexpected message {:?} during COPY", char::from(tag)),
            }
            if matches!(tag, b'c' | b'f') {
                return Ok(());
            }
        }
    }

    /// After an error in an extended-protocol unit with no `Sync` yet, read
    /// and drop the client's messages up to its `Sync`.
    async fn discard_until_sync(&mut self) -> Result<()> {
        loop {
            let frame = self
                .client
                .next()
                .await?
                .context("the client closed the connection")?;
            if frame.tag() == b'S' {
                return Ok(());
            }
        }
    }

    /// Tell the client why the session ends, then close it.
    async fn say_goodbye(&mut self, sqlstate: &str, message: &str) {
        let error = wire::error_response("FATAL", sqlstate, message, None);
        let _ = wire::write_frames(self.client.stream(), [&error]).await;
        let _ = wire::write_frames(self.server.stream(), [&Frame::new(b'X', &[])]).await;
    }
}

/// The messages of the unit being read: a simple `Query`, a `Terminate`, or
/// extended-protocol messages up to `Sync` (or a `Flush` that asks for
/// answers before it). Bounded in messages and in bytes, so one agent cannot
/// make the gateway hold an unbounded batch.
#[derive(Default)]
struct UnitBuffer {
    frames: Vec<Frame>,
    bytes: usize,
}

impl UnitBuffer {
    fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    /// Add one message; `true` once the unit is complete.
    fn push(&mut self, frame: Frame) -> Result<bool> {
        let tag = frame.tag();
        self.bytes += frame.as_bytes().len();
        self.frames.push(frame);
        if self.frames.len() > MAX_UNIT_MESSAGES || self.bytes > MAX_UNIT_BYTES {
            bail!("a unit of more than {MAX_UNIT_MESSAGES} messages or {MAX_UNIT_BYTES} bytes before its Sync");
        }
        Ok(match tag {
            b'Q' | b'X' | b'F' => self.frames.len() == 1,
            b'S' | b'H' => true,
            _ => false,
        })
    }

    fn take(&mut self) -> Vec<Frame> {
        self.bytes = 0;
        std::mem::take(&mut self.frames)
    }
}

/// Classify every message of a unit (in the parse pool), against the
/// session's prepared statements.
async fn judge(parse_pool: &ParsePool, frames: Vec<Frame>, names: &Names) -> Judged {
    let mut draft = Draft::new(names);
    let mut classified = Classified::Housekeeping;
    let mut audit = String::new();
    let mut synced = false;
    let alone = frames.len() == 1;
    for frame in &frames {
        let verdict = match frame.tag() {
            // A simple query inside an extended batch answers with its own
            // ReadyForQuery mid-unit; no driver sends one.
            b'Q' if !alone => Classified::Forbidden(reason::UNCHECKABLE),
            b'Q' => match cstr(frame) {
                Ok(sql) => {
                    synced = true;
                    let analysis = analyze(parse_pool, sql).await;
                    add_audit(&mut audit, &analysis.audit);
                    sql_effects(analysis, &mut draft)
                }
                Err(_) => Classified::Forbidden(reason::UNCHECKABLE),
            },
            b'P' => match parse_message(frame) {
                Ok((name, sql)) => parse(parse_pool, &name, sql, &mut draft).await,
                Err(_) => Classified::Forbidden(reason::UNCHECKABLE),
            },
            b'B' => match bind_message(frame) {
                Ok((portal, statement)) => {
                    let (verdict, statement_audit) = draft.bind(&portal, &statement);
                    add_audit(&mut audit, &statement_audit);
                    verdict
                }
                Err(_) => Classified::Forbidden(reason::UNCHECKABLE),
            },
            b'E' => match name_message(frame) {
                Ok(portal) => draft.execute(&portal),
                Err(_) => Classified::Forbidden(reason::UNCHECKABLE),
            },
            b'C' => match close_message(frame) {
                Ok((b'S', name)) => {
                    draft.deallocate(&name, Via::Message);
                    Classified::Housekeeping
                }
                Ok((b'P', _)) => {
                    draft.close_portal();
                    Classified::Housekeeping
                }
                _ => Classified::Forbidden(reason::UNCHECKABLE),
            },
            b'S' => {
                synced = true;
                Classified::Housekeeping
            }
            b'D' | b'H' => Classified::Housekeeping,
            b'F' => Classified::Forbidden(reason::FUNCTION_CALL),
            _ => Classified::Forbidden(reason::UNCHECKABLE),
        };
        classified = classified.combine(verdict);
    }
    Judged {
        frames,
        classified,
        audit,
        sent: draft.finish(),
        synced,
    }
}

async fn analyze(parse_pool: &ParsePool, sql: String) -> Analysis {
    let bytes = sql.len();
    parse_pool
        .run(bytes, move || classify::analyze(&sql))
        .await
        .unwrap_or_else(|| Analysis {
            classified: Classified::Forbidden(reason::UNCHECKABLE),
            audit: String::new(),
            effects: Vec::new(),
        })
}

/// A `Parse`: remember what the statement runs. Preparing runs nothing, so
/// it is refused only when the statement is refused outright.
async fn parse(
    parse_pool: &ParsePool,
    name: &[u8],
    sql: String,
    draft: &mut Draft<'_>,
) -> Classified {
    let analysis = analyze(parse_pool, sql).await;
    let mut classified = analysis.classified;
    let mut executes = None;
    for effect in analysis.effects {
        match effect {
            // Looked up each time the statement runs.
            Effect::Execute { name } if executes.is_none() => {
                executes = Some(names::key(name.as_bytes()));
            }
            // Prepares or drops statements when it runs, which nothing
            // names until then, so the gateway could not follow it.
            _ => classified = classified.combine(Classified::Forbidden(reason::UNCHECKABLE)),
        }
    }
    let verdict = match &classified {
        refused @ (Classified::Forbidden(_) | Classified::Unparseable(_)) => refused.clone(),
        _ => Classified::Housekeeping,
    };
    let prepared = Prepared {
        classified,
        audit: analysis.audit,
        executes,
    };
    match draft.prepare(name, prepared, Via::Message) {
        Ok(()) => verdict,
        Err(why) => Classified::Forbidden(why),
    }
}

/// The verdict for one SQL text, recording in `draft` what it does to the
/// server's prepared statements: an `EXECUTE` adds what its statement runs.
fn sql_effects(analysis: Analysis, draft: &mut Draft<'_>) -> Classified {
    let mut verdict = analysis.classified;
    for effect in analysis.effects {
        let effect_verdict = match effect {
            Effect::Prepare { name, runs, audit } => {
                match draft.prepare(name.as_bytes(), Prepared::new(runs, audit), Via::Sql) {
                    Ok(()) => Classified::Housekeeping,
                    Err(why) => Classified::Forbidden(why),
                }
            }
            Effect::Execute { name } => draft.runs_statement(name.as_bytes()),
            Effect::Deallocate { name } => {
                draft.deallocate(name.as_bytes(), Via::Sql);
                Classified::Housekeeping
            }
            Effect::DeallocateAll => {
                draft.deallocate_all();
                Classified::Housekeeping
            }
        };
        verdict = verdict.combine(effect_verdict);
    }
    verdict
}

fn add_audit(audit: &mut String, more: &str) {
    if more.is_empty() || audit.len() > classify::MAX_AUDIT_CHARS * 4 {
        return;
    }
    if !audit.is_empty() {
        audit.push_str("; ");
    }
    audit.push_str(more);
}

/// The SQL text of a `Query`.
fn cstr(frame: &Frame) -> std::io::Result<String> {
    Reader::new(frame.body()).cstr()
}

/// The portal name an `Execute` starts with. Names are raw bytes: the server
/// keys them by bytes, whatever their encoding.
fn name_message(frame: &Frame) -> std::io::Result<Vec<u8>> {
    Reader::new(frame.body()).name()
}

/// A `Parse`'s statement name and SQL text.
fn parse_message(frame: &Frame) -> std::io::Result<(Vec<u8>, String)> {
    let mut body = Reader::new(frame.body());
    Ok((body.name()?, body.cstr()?))
}

/// A `Bind`'s portal and statement names.
fn bind_message(frame: &Frame) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
    let mut body = Reader::new(frame.body());
    Ok((body.name()?, body.name()?))
}

/// A `Close`'s kind (`S` statement, `P` portal) and name.
fn close_message(frame: &Frame) -> std::io::Result<(u8, Vec<u8>)> {
    let mut body = Reader::new(frame.body());
    Ok((body.u8()?, body.name()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbproxy::statement::StatementClass::{Read, Schema, Write};

    fn query(sql: &str) -> Frame {
        wire::query(sql)
    }

    fn parse_frame(name: &str, sql: &str) -> Frame {
        let mut body = Vec::new();
        for part in [name, sql] {
            body.extend_from_slice(part.as_bytes());
            body.push(0);
        }
        body.extend_from_slice(&[0, 0]);
        Frame::new(b'P', &body)
    }

    fn bind_frame(portal: &str, statement: &str) -> Frame {
        let mut body = Vec::new();
        for part in [portal, statement] {
            body.extend_from_slice(part.as_bytes());
            body.push(0);
        }
        body.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        Frame::new(b'B', &body)
    }

    fn execute_frame(portal: &str) -> Frame {
        let mut body = portal.as_bytes().to_vec();
        body.extend_from_slice(&[0, 0, 0, 0, 0]);
        Frame::new(b'E', &body)
    }

    fn sync() -> Frame {
        Frame::new(b'S', &[])
    }

    /// Judge `frames` as one unit, send it, and have the server answer
    /// every change in it.
    async fn run(pool: &ParsePool, names: &mut Names, frames: Vec<Frame>) -> Classified {
        let judged = judge(pool, frames, names).await;
        names.send(judged.sent);
        for (tag, body) in [
            (b'1', &b""[..]),
            (b'C', b"PREPARE\0"),
            (b'C', b"DEALLOCATE\0"),
        ]
        .repeat(4)
        {
            names.observe(tag, body);
        }
        names.observe(b'Z', b"T");
        judged.classified
    }

    #[tokio::test]
    async fn executes_are_judged_by_what_they_run() {
        let pool = ParsePool::new().unwrap();
        let mut names = Names::default();
        run(
            &pool,
            &mut names,
            vec![query("PREPARE del AS DELETE FROM t")],
        )
        .await;
        assert_eq!(
            run(&pool, &mut names, vec![query("EXECUTE del")]).await,
            Classified::Judged(Write)
        );
        run(&pool, &mut names, vec![query("PREPARE sel AS SELECT 1")]).await;
        assert_eq!(
            run(&pool, &mut names, vec![query("EXECUTE sel")]).await,
            Classified::Judged(Read)
        );
        assert_eq!(
            run(
                &pool,
                &mut names,
                vec![query("PREPARE x AS SELECT 1; DEALLOCATE x; EXECUTE x")]
            )
            .await,
            Classified::Judged(Write),
            "a deallocated name is no longer trusted"
        );
        assert_eq!(
            run(&pool, &mut names, vec![query("EXECUTE never_seen")]).await,
            Classified::Judged(Write),
            "a statement prepared out of view is at least a write"
        );
    }

    /// A portal is judged when it is bound: running more of it (here SQL
    /// `FETCH`, which names it) runs only what that judgement covered.
    #[tokio::test]
    async fn binding_a_portal_is_judged_by_its_statement() {
        let pool = ParsePool::new().unwrap();
        let mut names = Names::default();
        assert_eq!(
            run(
                &pool,
                &mut names,
                vec![
                    parse_frame("del", "DELETE FROM t RETURNING id"),
                    bind_frame("c", "del"),
                    sync(),
                ]
            )
            .await,
            Classified::Judged(Write)
        );
        assert_eq!(
            run(
                &pool,
                &mut names,
                vec![parse_frame("drop", "DROP TABLE t"), sync()]
            )
            .await,
            Classified::Housekeeping,
            "preparing runs nothing"
        );
        assert_eq!(
            run(
                &pool,
                &mut names,
                vec![bind_frame("", "drop"), execute_frame(""), sync()]
            )
            .await,
            Classified::Judged(Schema)
        );
    }

    /// `EXECUTE name` inside a protocol statement runs whatever the name
    /// holds when the portal runs.
    #[tokio::test]
    async fn a_protocol_execute_is_judged_each_time_it_runs() {
        let pool = ParsePool::new().unwrap();
        let mut names = Names::default();
        run(&pool, &mut names, vec![query("PREPARE target AS SELECT 1")]).await;
        run(
            &pool,
            &mut names,
            vec![parse_frame("outer", "EXECUTE target"), sync()],
        )
        .await;
        assert_eq!(
            run(&pool, &mut names, vec![bind_frame("", "outer"), sync()]).await,
            Classified::Judged(Read)
        );
        run(
            &pool,
            &mut names,
            vec![query(
                "DEALLOCATE target; PREPARE target AS DELETE FROM t RETURNING 1",
            )],
        )
        .await;
        assert_eq!(
            run(&pool, &mut names, vec![execute_frame(""), sync()]).await,
            Classified::Judged(Write),
            "the unnamed portal runs the new target"
        );
        assert_eq!(
            run(
                &pool,
                &mut names,
                vec![bind_frame("named", "outer"), sync()]
            )
            .await,
            Classified::Forbidden(reason::NAMED_PORTAL_EXECUTE),
            "SQL could fetch a named portal out of the gateway's view"
        );
    }

    #[tokio::test]
    async fn statements_that_change_names_when_run_are_refused_at_parse() {
        let pool = ParsePool::new().unwrap();
        let mut names = Names::default();
        for sql in ["PREPARE p AS SELECT 1", "DEALLOCATE ALL"] {
            assert_eq!(
                run(&pool, &mut names, vec![parse_frame("", sql), sync()]).await,
                Classified::Forbidden(reason::UNCHECKABLE),
                "{sql}"
            );
        }
        assert_eq!(
            run(
                &pool,
                &mut names,
                vec![parse_frame("", "SELECT 1"), query("SELECT 2"), sync()]
            )
            .await,
            Classified::Forbidden(reason::UNCHECKABLE),
            "a simple query inside an extended batch"
        );
    }

    #[test]
    fn units_end_where_the_server_runs_them_and_are_bounded() {
        let mut unit = UnitBuffer::default();
        assert!(unit.push(query("SELECT 1")).unwrap(), "a query alone");
        assert_eq!(unit.take().len(), 1);
        assert!(unit.is_empty());

        assert!(!unit.push(parse_frame("", "SELECT 1")).unwrap());
        assert!(!unit.push(query("SELECT 2")).unwrap(), "not alone");
        assert!(unit.push(sync()).unwrap());
        unit.take();

        let big = Frame::new(b'd', &vec![0; MAX_UNIT_BYTES / 2]);
        assert!(!unit.push(big.clone()).unwrap());
        assert!(unit.push(big).is_err(), "over the byte bound");
        unit.take();

        for _ in 0..MAX_UNIT_MESSAGES {
            assert!(!unit.push(bind_frame("", "")).unwrap());
        }
        assert!(unit.push(bind_frame("", "")).is_err(), "over the count");
    }

    #[test]
    fn protocol_messages_read_their_names() {
        assert_eq!(
            parse_message(&parse_frame("q", "SELECT 1")).unwrap(),
            (b"q".to_vec(), "SELECT 1".to_string())
        );
        assert_eq!(
            bind_message(&bind_frame("p", "q")).unwrap(),
            (b"p".to_vec(), b"q".to_vec())
        );
        assert_eq!(
            close_message(&Frame::new(b'C', b"Sq\0")).unwrap(),
            (b'S', b"q".to_vec())
        );
        assert!(parse_message(&Frame::new(b'P', b"q")).is_err());
        // Names are bytes: one that is not UTF-8 still reads.
        assert_eq!(
            name_message(&Frame::new(b'E', b"\xff\0\0\0\0\0")).unwrap(),
            vec![0xff]
        );
    }
}
