//! What one PostgreSQL message's SQL text does, in [`dbproxy::statement`]'s
//! terms.
//!
//! The text is split into statements and summarized by PostgreSQL's own
//! parser (`libpg_query`), so the gateway reads every statement the way the
//! server will. Each statement then gets one [`Classified`]:
//!
//! - **Forbidden**: it reaches past the session the gateway governs (server
//!   files, programs, other servers, code in unsandboxed languages, system
//!   catalogs, and the guarded settings in [`crate::settings`]);
//! - **Housekeeping**: transaction control and session state that touch no
//!   data and are never judged;
//! - **Judged**: everything else, as the strictest of
//!   [`StatementClass::Read`] (provably reads only), `Write`, or `Schema`.
//!
//! The summary lists what most statements call; the scanner in
//! [`crate::tokens`] covers the places it does not look (the arguments of
//! `EXECUTE`, `COPY ... WHERE`, the query of `DECLARE`, expressions in DDL).
//!
//! A statement that prepares, runs or drops a named prepared statement
//! reports it in [`Analysis::effects`], so the session (which knows what each
//! name was bound to) judges running one by what it runs.
//!
//! Every gap fails closed: a statement type the classifier does not know is a
//! schema change, a function it does not know is a write, and a name it
//! cannot read is refused. The bodies of functions and `DO` blocks are text
//! the gateway never sees, so creating either is a schema change, and only
//! the database role's own privileges bound what that code does.

use std::collections::HashSet;

use dbproxy::limits::MAX_PARSED_STATEMENT_BYTES;
use dbproxy::statement::{Classified, StatementClass};
use pg_query::protobuf::summary_result::Context;
use pg_query::protobuf::Token;

use crate::functions::{self, FunctionKind};
use crate::reason;
use crate::settings;
use crate::tokens::{clamp_chars, Call, Tokens};

/// The longest audit text kept for one message: what the request log and an
/// approval card show.
pub const MAX_AUDIT_CHARS: usize = 4000;

/// Languages whose code runs sandboxed inside the server. Code in any other
/// language reaches the server's operating system (`plpython3u`) or binds to
/// a library (`c`, `internal`).
const SANDBOXED_LANGUAGES: &[&str] = &["plperl", "plpgsql", "pltcl", "plv8", "sql"];

/// One message's text, analyzed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Analysis {
    /// The verdict for the whole text.
    pub classified: Classified,
    /// The text with every literal replaced by a placeholder and comments
    /// dropped, clamped to [`MAX_AUDIT_CHARS`].
    pub audit: String,
    /// What the text does to the session's prepared statements, in order.
    pub effects: Vec<Effect>,
}

/// A statement that prepares, runs or drops a named prepared statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// `PREPARE name AS ...`: what running it will do, and its audit text.
    Prepare {
        name: String,
        runs: Classified,
        audit: String,
    },
    /// `EXECUTE name(...)`, alone or inside `EXPLAIN ANALYZE` or
    /// `CREATE TABLE AS`. The statement's own verdict covers the arguments;
    /// the session combines it with what the prepared statement runs.
    Execute { name: String },
    /// `DEALLOCATE name`.
    Deallocate { name: String },
    /// `DEALLOCATE ALL` or `DISCARD ALL`.
    DeallocateAll,
}

/// Analyze `sql`. Runs the parser, so call it through
/// [`dbproxy::parse_pool::ParsePool`], never on an async worker thread.
#[must_use]
pub fn analyze(sql: &str) -> Analysis {
    if sql.len() > MAX_PARSED_STATEMENT_BYTES {
        return refused(Classified::Forbidden(reason::TOO_LARGE));
    }
    // Statement boundaries fall between tokens, and a token never splits a
    // UTF-8 character, so the library's slicing of `sql` stays on character
    // boundaries.
    let statements = match pg_query::split_with_parser(sql) {
        Ok(statements) => statements,
        Err(error) => return unparseable(error),
    };
    let mut classified = Classified::Housekeeping;
    let mut effects = Vec::new();
    let mut audit = String::new();
    for text in statements {
        let tokens = match Tokens::scan(text) {
            Ok(tokens) => tokens,
            Err(error) => return unparseable(error),
        };
        let summary = match pg_query::summary(text, -1) {
            Ok(summary) => summary,
            Err(error) => return unparseable(error),
        };
        let statement = Statement {
            text,
            tokens: &tokens,
            summary: &summary,
        };
        classified = classified.combine(statement.classify(&mut effects));
        // Bytes bound characters from above: past this, the cut is certain.
        if audit.len() <= MAX_AUDIT_CHARS * 4 && !tokens.is_empty() {
            if !audit.is_empty() {
                audit.push_str("; ");
            }
            audit.push_str(&tokens.audit_text(MAX_AUDIT_CHARS));
        }
    }
    Analysis {
        classified,
        audit: clamp_chars(audit, MAX_AUDIT_CHARS),
        effects,
    }
}

fn refused(classified: Classified) -> Analysis {
    Analysis {
        classified,
        audit: String::new(),
        effects: Vec::new(),
    }
}

/// The parser's own message, as the server would have answered.
fn unparseable(error: pg_query::Error) -> Analysis {
    let message = match error {
        pg_query::Error::Parse(message)
        | pg_query::Error::Scan(message)
        | pg_query::Error::Split(message) => message,
        pg_query::Error::Conversion(_) => "invalid byte sequence: 0x00".to_string(),
        _ => return refused(Classified::Forbidden(reason::UNCHECKABLE)),
    };
    refused(Classified::Unparseable(message))
}

/// A statement nested inside another (`PREPARE ... AS`, `DECLARE ... FOR`,
/// `COPY (...) TO`), classified on its own. The grammar allows only queries
/// and data changes there, so it holds no prepared-statement effects.
fn nested(text: &str) -> Classified {
    analyze(text).classified
}

/// One statement and what the parser and scanner made of it.
struct Statement<'a> {
    text: &'a str,
    tokens: &'a Tokens<'a>,
    summary: &'a pg_query::SummaryResult,
}

impl Statement<'_> {
    fn classify(&self, effects: &mut Vec<Effect>) -> Classified {
        let Some(top) = self.summary.statement_types.first() else {
            // Only comments or whitespace.
            return Classified::Housekeeping;
        };
        let by_type = self.by_type(top, effects);
        // Preparing runs nothing; its calls are judged when it runs.
        if top == "PrepareStmt" {
            return by_type;
        }
        by_type.combine(self.calls())
    }

    fn has_type(&self, name: &str) -> bool {
        self.summary.statement_types.iter().any(|t| t == name)
    }

    /// The verdict from the statement's own type, before its calls.
    fn by_type(&self, top: &str, effects: &mut Vec<Effect>) -> Classified {
        use StatementClass::{Read, Schema, Write};
        match top {
            "SelectStmt" => self.query(),
            "InsertStmt" | "UpdateStmt" | "DeleteStmt" | "MergeStmt" => self.write(),
            "ExplainStmt" => self.explain(effects),
            "ExecuteStmt" => self.execute(effects, Read),
            "CreateTableAsStmt" => self.create_table_as(effects),
            "PrepareStmt" => self.prepare(effects),
            "DeallocateStmt" => self.deallocate(effects),
            "DiscardStmt" => {
                if self.tokens.is(1, Token::All) {
                    effects.push(Effect::DeallocateAll);
                }
                Classified::Housekeeping
            }
            "DeclareCursorStmt" => self.declare(),
            "CopyStmt" => self.copy(),
            "VariableSetStmt" | "AlterRoleSetStmt" | "AlterDatabaseSetStmt" => self.setting(top),
            "TransactionStmt" => self.transaction(),
            "CreateFunctionStmt" => self
                .language(self.after_parameters(), "sql")
                .combine(self.function_settings()),
            "AlterFunctionStmt" => self.function_settings(),
            "DoStmt" => self.language(1, "plpgsql"),
            "AlterSystemStmt" => Classified::Forbidden(reason::SERVER_CONFIG),
            "LoadStmt" => Classified::Forbidden(reason::LIBRARY),
            "CreateFdwStmt"
            | "AlterFdwStmt"
            | "CreateForeignServerStmt"
            | "AlterForeignServerStmt"
            | "CreateUserMappingStmt"
            | "AlterUserMappingStmt"
            | "CreateSubscriptionStmt"
            | "AlterSubscriptionStmt" => Classified::Forbidden(reason::OTHER_SERVERS),
            // Session state, and reading results a judged statement made.
            "VariableShowStmt" | "FetchStmt" | "ClosePortalStmt" | "ListenStmt"
            | "UnlistenStmt" | "ConstraintsSetStmt" => Classified::Housekeeping,
            // Effects other sessions see, without a data change of its own.
            "NotifyStmt" | "LockStmt" | "CallStmt" => Classified::Judged(Write),
            // DDL, privileges, physical storage, server-wide actions, and any
            // statement type this list does not know.
            _ => Classified::Judged(Schema),
        }
    }

    /// A query: a read, unless it writes through a CTE, creates a table
    /// (`SELECT ... INTO`), or locks rows.
    fn query(&self) -> Classified {
        if ["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]
            .iter()
            .any(|t| self.has_type(t))
        {
            return self.write();
        }
        if self
            .summary
            .tables
            .iter()
            .any(|t| t.context == Context::Ddl)
        {
            return Classified::Judged(StatementClass::Schema);
        }
        if self.tokens.has_locking_clause() {
            return Classified::Judged(StatementClass::Write);
        }
        Classified::Judged(StatementClass::Read)
    }

    /// A data change, refused when it writes server settings or a system
    /// catalog.
    fn write(&self) -> Classified {
        self.writing(|context| context == Context::Dml)
    }

    /// The tables the statement writes (`target` picks them by the context
    /// the summary reports), checked for settings and catalogs.
    fn writing(&self, target: impl Fn(Context) -> bool) -> Classified {
        for table in self.summary.tables.iter().filter(|t| target(t.context)) {
            let (schema, name) = (table.schema_name.as_str(), table.table_name.as_str());
            if settings::is_settings_view(schema, name) {
                return Classified::Forbidden(reason::SETTING_NAME);
            }
            if is_catalog(schema, name) {
                return Classified::Forbidden(reason::CATALOG);
            }
        }
        Classified::Judged(StatementClass::Write)
    }

    /// `EXPLAIN` only plans its statement; with `ANALYZE` it also runs it.
    fn explain(&self, effects: &mut Vec<Effect>) -> Classified {
        if !self.explain_runs() {
            return Classified::Judged(StatementClass::Read);
        }
        match self.summary.statement_types.get(1).map(String::as_str) {
            Some("SelectStmt") => self.query(),
            Some("InsertStmt" | "UpdateStmt" | "DeleteStmt" | "MergeStmt") => self.write(),
            Some("ExecuteStmt") => self.execute(effects, StatementClass::Read),
            Some("CreateTableAsStmt") => self.create_table_as(effects),
            _ => Classified::Judged(StatementClass::Schema),
        }
    }

    /// Whether an `EXPLAIN` names `ANALYZE` at all: in the old form right
    /// after `EXPLAIN`, or anywhere in the option list. A repeated option
    /// takes its last value, so any mention counts as running.
    fn explain_runs(&self) -> bool {
        let t = self.tokens;
        let options_end = if t.is(1, Token::Ascii40) {
            t.closing_paren(1).unwrap_or(t.len())
        } else {
            2
        };
        (1..options_end).any(|i| matches!(t.kind(i), Token::Analyze | Token::Analyse))
    }

    /// `CREATE TABLE ... AS` / `CREATE MATERIALIZED VIEW ... AS`, possibly
    /// filled by running a prepared statement.
    fn create_table_as(&self, effects: &mut Vec<Effect>) -> Classified {
        if self.has_type("ExecuteStmt") {
            return self.execute(effects, StatementClass::Schema);
        }
        Classified::Judged(StatementClass::Schema)
    }

    /// Running the prepared statement named after the statement's top-level
    /// `EXECUTE`, as `class` before what it runs.
    fn execute(&self, effects: &mut Vec<Effect>, class: StatementClass) -> Classified {
        let t = self.tokens;
        let name = t
            .find_top_level(0, &[Token::Execute])
            .and_then(|at| t.name(at + 1));
        let Some(name) = name else {
            return Classified::Forbidden(reason::UNREADABLE_NAME);
        };
        effects.push(Effect::Execute { name });
        Classified::Judged(class)
    }

    /// `PREPARE name [(types)] AS <statement>`: preparing runs nothing, so
    /// it is housekeeping unless what it prepares is forbidden outright.
    fn prepare(&self, effects: &mut Vec<Effect>) -> Classified {
        let t = self.tokens;
        let Some(name) = t.name(1) else {
            return Classified::Forbidden(reason::UNREADABLE_NAME);
        };
        let Some(as_at) = t.find_top_level(2, &[Token::As]) else {
            return Classified::Forbidden(reason::UNCHECKABLE);
        };
        let prepared = analyze(t.rest(as_at + 1));
        if let Classified::Judged(_) = prepared.classified {
            effects.push(Effect::Prepare {
                name,
                runs: prepared.classified,
                audit: prepared.audit,
            });
            return Classified::Housekeeping;
        }
        prepared.classified
    }

    /// `DEALLOCATE [PREPARE] name | ALL`.
    fn deallocate(&self, effects: &mut Vec<Effect>) -> Classified {
        let t = self.tokens;
        let at = if t.is(1, Token::Prepare) { 2 } else { 1 };
        if t.is(at, Token::All) {
            effects.push(Effect::DeallocateAll);
        } else if let Some(name) = t.name(at) {
            effects.push(Effect::Deallocate { name });
        } else {
            return Classified::Forbidden(reason::UNREADABLE_NAME);
        }
        Classified::Housekeeping
    }

    /// `DECLARE c CURSOR FOR <query>`: the summary does not look inside, so
    /// the query is classified on its own. Fetching from the cursor later is
    /// housekeeping.
    fn declare(&self) -> Classified {
        let t = self.tokens;
        match t.find_top_level(1, &[Token::For]) {
            Some(for_at) => nested(t.rest(for_at + 1)),
            None => Classified::Forbidden(reason::UNCHECKABLE),
        }
    }

    /// `COPY` to or from the client only: a file or program on the server is
    /// forbidden. Copying in writes its table; copying out reads it or runs
    /// its query.
    fn copy(&self) -> Classified {
        let t = self.tokens;
        let Some(direction) = t.find_top_level(1, &[Token::From, Token::To]) else {
            return Classified::Forbidden(reason::UNCHECKABLE);
        };
        match t.kind(direction + 1) {
            Token::Program => return Classified::Forbidden(reason::PROGRAMS),
            Token::Stdin | Token::Stdout => {}
            _ => return Classified::Forbidden(reason::SERVER_FILES),
        }
        if t.is(direction, Token::From) {
            // The summary reports a COPY's table as read in both directions.
            return self.writing(|_| true);
        }
        if t.is(1, Token::Ascii40) {
            return match t.closing_paren(1) {
                Some(close) => nested(t.span(2, close)),
                None => Classified::Forbidden(reason::UNCHECKABLE),
            };
        }
        Classified::Judged(StatementClass::Read)
    }

    /// `SET`, `RESET`, and stored defaults (`ALTER ROLE` / `ALTER DATABASE
    /// ... SET`), which are a schema-level change.
    fn setting(&self, top: &str) -> Classified {
        if let Some(why) = settings::check_statement(self.text) {
            return Classified::Forbidden(why);
        }
        if top == "VariableSetStmt" {
            Classified::Housekeeping
        } else {
            Classified::Judged(StatementClass::Schema)
        }
    }

    /// Transaction control. Two-phase commit is judged as a write:
    /// `PREPARE TRANSACTION` leaves the transaction's locks and changes
    /// behind for any session to settle, and `COMMIT PREPARED` /
    /// `ROLLBACK PREPARED` settle one that may belong to another session.
    fn transaction(&self) -> Classified {
        if let Some(why) = settings::check_statement(self.text) {
            return Classified::Forbidden(why);
        }
        let t = self.tokens;
        let two_phase = match t.kind(0) {
            Token::Commit | Token::Rollback => t.is(1, Token::Prepared),
            Token::Prepare => t.is(1, Token::Transaction),
            _ => false,
        };
        if two_phase {
            return Classified::Judged(StatementClass::Write);
        }
        Classified::Housekeeping
    }

    /// The index just past a new function's parameter list.
    fn after_parameters(&self) -> usize {
        let t = self.tokens;
        (0..t.len())
            .find(|&i| t.is(i, Token::Ascii40))
            .and_then(|open| t.closing_paren(open))
            .map_or(t.len(), |close| close + 1)
    }

    /// The language a new function or a `DO` block is written in, found
    /// from token `from` on (`default` when the statement names none).
    fn language(&self, from: usize, default: &str) -> Classified {
        let t = self.tokens;
        let language = match t.find_top_level(from, &[Token::Language]) {
            Some(at) => t.name(at + 1).or_else(|| t.string(at + 1)),
            None => Some(default.to_string()),
        };
        match language.as_deref() {
            Some("c" | "internal") => Classified::Forbidden(reason::LIBRARY),
            Some(language) if SANDBOXED_LANGUAGES.contains(&language) => {
                Classified::Judged(StatementClass::Schema)
            }
            _ => Classified::Forbidden(reason::UNTRUSTED_LANGUAGE),
        }
    }

    /// The settings a function applies while it runs (`SET` clauses of
    /// `CREATE FUNCTION` / `ALTER FUNCTION`) must keep the guards too.
    fn function_settings(&self) -> Classified {
        let t = self.tokens;
        let sets = (0..t.len()).any(|i| matches!(t.kind(i), Token::Set | Token::Reset));
        match settings::check_function(self.text).filter(|_| sets) {
            Some(why) => Classified::Forbidden(why),
            None => Classified::Judged(StatementClass::Schema),
        }
    }

    /// The verdict from every function the statement calls: the summary's
    /// list, which resolves names the scanner cannot (`U&"..."`), and the
    /// scanner's call positions, which cover the places the summary does not
    /// look.
    fn calls(&self) -> Classified {
        let mut verdict = Classified::Housekeeping;
        let mut listed = HashSet::new();
        let mut listed_set_config = false;
        for function in &self.summary.functions {
            // DDL that names a function (`DROP FUNCTION f`, `GRANT ... ON
            // FUNCTION f`) does not call it.
            if function.context == Context::Ddl {
                continue;
            }
            let schema = function.schema_name.as_deref();
            let name = function.function_name.as_str();
            listed.insert((function.schema_name.clone(), name.to_string()));
            if is_set_config(schema, name) {
                // Judged from its arguments, which only the scanner reads.
                listed_set_config = true;
                continue;
            }
            verdict = verdict.combine(function_verdict(schema, name));
        }
        let unlisted_from = self.unlisted_calls_from();
        let mut scanned_set_config = false;
        for call in self.tokens.calls() {
            scanned_set_config |= call
                .name
                .as_deref()
                .is_some_and(|name| is_set_config(call.schema.as_deref(), name));
            verdict = verdict.combine(self.scanned_call(&call, &listed, unlisted_from));
        }
        if listed_set_config && !scanned_set_config {
            verdict = verdict.combine(Classified::Forbidden(reason::SETTING_NAME));
        }
        verdict
    }

    /// Where the calls the summary does not list begin: the arguments after
    /// `EXECUTE name`, and the filter after `COPY ... WHERE`.
    fn unlisted_calls_from(&self) -> Option<usize> {
        let t = self.tokens;
        if self.has_type("ExecuteStmt") {
            return t.find_top_level(0, &[Token::Execute]);
        }
        if self.has_type("CopyStmt") {
            return t.find_top_level(1, &[Token::Where]);
        }
        None
    }

    /// One call position the scanner found.
    fn scanned_call(
        &self,
        call: &Call,
        listed: &HashSet<(Option<String>, String)>,
        unlisted_from: Option<usize>,
    ) -> Classified {
        let (Some(name), schema) = (call.name.as_deref(), call.schema.as_deref()) else {
            return Classified::Forbidden(reason::UNREADABLE_NAME);
        };
        if schema == Some("") {
            return Classified::Forbidden(reason::UNREADABLE_NAME);
        }
        if is_set_config(schema, name) {
            return match settings::check_set_config(self.tokens, call.at) {
                Some(why) => Classified::Forbidden(why),
                None => Classified::Judged(StatementClass::Write),
            };
        }
        if listed.contains(&(call.schema.clone(), name.to_string())) {
            return Classified::Housekeeping;
        }
        // Outside the unlisted places the position may be no call at all (a
        // table before its column list), so only the forbidden and server
        // lists apply there.
        let unlisted = unlisted_from.is_some_and(|from| call.at > from);
        match functions::kind(schema, name) {
            Some(kind @ (FunctionKind::Forbidden(_) | FunctionKind::Server)) => kind_verdict(kind),
            _ if unlisted => function_verdict(schema, name),
            _ => Classified::Housekeeping,
        }
    }
}

/// `set_config` as the server resolves it: unqualified names find the
/// catalog's, since `pg_catalog` is searched first.
fn is_set_config(schema: Option<&str>, name: &str) -> bool {
    name == "set_config" && matches!(schema, None | Some("pg_catalog"))
}

/// A system catalog table. Unqualified `pg_` names resolve there first.
fn is_catalog(schema: &str, table: &str) -> bool {
    matches!(schema, "pg_catalog" | "pg_toast") || (schema.is_empty() && table.starts_with("pg_"))
}

/// What calling `schema.name` makes the statement.
fn function_verdict(schema: Option<&str>, name: &str) -> Classified {
    match functions::kind(schema, name) {
        Some(kind) => kind_verdict(kind),
        None => Classified::Judged(StatementClass::Write),
    }
}

fn kind_verdict(kind: FunctionKind) -> Classified {
    match kind {
        FunctionKind::Pure => Classified::Housekeeping,
        FunctionKind::Server => Classified::Judged(StatementClass::Schema),
        FunctionKind::Forbidden(why) => Classified::Forbidden(why),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Classified::{Forbidden, Housekeeping, Judged};
    use StatementClass::{Read, Schema, Write};

    fn class(sql: &str) -> Classified {
        analyze(sql).classified
    }

    fn assert_all(want: &Classified, cases: &[&str]) {
        for sql in cases {
            assert_eq!(&class(sql), want, "{sql}");
        }
    }

    #[test]
    fn queries_that_only_read_are_reads() {
        assert_all(
            &Judged(Read),
            &[
                "SELECT 1",
                "select * from t where a = $1",
                "VALUES (1)",
                "TABLE t",
                "WITH x AS (SELECT 1) SELECT * FROM x",
                "SELECT lower(name), now(), count(*) FROM t GROUP BY 1",
                "SELECT substring('abc' from 1 for 2), trim(both ' ' from 'x')",
                "SELECT pg_catalog.lower('A')",
                "SELECT 'é'; SELECT 'ß'",
                "EXPLAIN DELETE FROM t",
                "EXPLAIN EXECUTE p",
                "COPY t TO STDOUT",
                "COPY t (a, b) TO STDOUT WITH (FORMAT csv)",
                "COPY (SELECT a FROM t) TO STDOUT",
                "DECLARE c CURSOR WITH HOLD FOR SELECT * FROM t",
                "SELECT 1; SHOW work_mem; BEGIN",
            ],
        );
    }

    #[test]
    fn data_changes_locks_and_unknown_functions_are_writes() {
        assert_all(
            &Judged(Write),
            &[
                "INSERT INTO t VALUES (1)",
                "UPDATE t SET a = 1",
                "DELETE FROM t",
                "MERGE INTO t USING s ON t.a = s.a WHEN MATCHED THEN DELETE",
                "WITH d AS (DELETE FROM t RETURNING 1) SELECT * FROM d",
                "SELECT 1 INTERSECT (WITH d AS (UPDATE t SET a = 1 RETURNING a) SELECT a FROM d)",
                "SELECT * FROM t FOR UPDATE",
                "SELECT * FROM t FOR KEY SHARE",
                "SELECT myfn(1)",
                "SELECT public.lower('a')",
                "SELECT nextval('s')",
                "COPY t FROM STDIN",
                "COPY (DELETE FROM t RETURNING a) TO STDOUT",
                "COPY t TO STDOUT; COPY t FROM STDIN WHERE a > 1",
                "EXPLAIN ANALYZE DELETE FROM t",
                "EXPLAIN (ANALYZE off, ANALYZE) DELETE FROM t",
                "EXPLAIN (ANALYZE) SELECT myfn()",
                "EXPLAIN ANALYZE WITH d AS (DELETE FROM t RETURNING 1) SELECT * FROM d",
                "EXPLAIN SELECT myfn()",
                "DECLARE c CURSOR FOR SELECT myfn()",
                "EXECUTE p(myfn(1))",
                "NOTIFY c",
                "LOCK t",
                "CALL p()",
                "COMMIT PREPARED 'g'",
                "ROLLBACK PREPARED 'g'",
                "PREPARE TRANSACTION 'g'",
                "SELECT set_config('statement_timeout', '5s', false)",
                r#"SELECT "set_config"('application_name', 'x', true)"#,
            ],
        );
    }

    #[test]
    fn schema_changes_and_server_actions_are_schema() {
        assert_all(
            &Judged(Schema),
            &[
                "CREATE TABLE t (a int)",
                "DROP TABLE t",
                "ALTER TABLE t ADD b int DEFAULT myfn()",
                "GRANT SELECT ON t TO x",
                "TRUNCATE t",
                "VACUUM t",
                "CHECKPOINT",
                "SELECT 1 INTO x",
                "CREATE TABLE x AS SELECT 1",
                "REFRESH MATERIALIZED VIEW v",
                "IMPORT FOREIGN SCHEMA public FROM SERVER s INTO x",
                "DO $$BEGIN PERFORM 1; END$$",
                "DO 'BEGIN END' LANGUAGE plpgsql",
                "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1'",
                "CREATE FUNCTION f(language int) RETURNS int LANGUAGE 'plpgsql' AS 'x'",
                "CREATE FUNCTION f() RETURNS int RETURN 1",
                "CREATE FUNCTION f() RETURNS int LANGUAGE sql SET search_path = a AS 'select 1'",
                "ALTER FUNCTION f() SET work_mem = '1MB'",
                "ALTER ROLE me SET work_mem = '64MB'",
                "SELECT pg_terminate_backend(1)",
                "SELECT crosstab('select 1')",
                "CREATE ROLE x LOGIN",
            ],
        );
    }

    #[test]
    fn statements_reaching_past_the_session_are_forbidden() {
        for (sql, why) in [
            ("COPY t TO PROGRAM 'x'", reason::PROGRAMS),
            ("COPY t FROM PROGRAM 'x'", reason::PROGRAMS),
            ("COPY t FROM '/etc/passwd'", reason::SERVER_FILES),
            ("COPY (SELECT 1) TO '/tmp/x'", reason::SERVER_FILES),
            ("SELECT pg_read_file('x')", reason::SERVER_FILES),
            ("SELECT lo_import('/x')", reason::SERVER_FILES),
            ("EXECUTE p(pg_read_file('x'))", reason::SERVER_FILES),
            ("CREATE TABLE t (a text DEFAULT pg_read_file('x'))", reason::SERVER_FILES),
            ("DECLARE c CURSOR FOR SELECT pg_read_file('x')", reason::SERVER_FILES),
            ("PREPARE q AS SELECT pg_read_file('x')", reason::SERVER_FILES),
            ("COPY t FROM STDIN WHERE pg_read_file('x') = ''", reason::SERVER_FILES),
            ("SELECT dblink('h', 'q')", reason::OTHER_SERVERS),
            ("SELECT ext.dblink_exec('x')", reason::OTHER_SERVERS),
            ("CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw", reason::OTHER_SERVERS),
            ("CREATE USER MAPPING FOR me SERVER s", reason::OTHER_SERVERS),
            ("ALTER SERVER s OPTIONS (SET host 'x')", reason::OTHER_SERVERS),
            (
                "CREATE SUBSCRIPTION s CONNECTION 'host=x' PUBLICATION p",
                reason::OTHER_SERVERS,
            ),
            ("ALTER SYSTEM SET work_mem = '1MB'", reason::SERVER_CONFIG),
            ("LOAD 'x'", reason::LIBRARY),
            ("CREATE FUNCTION f() RETURNS int LANGUAGE c AS 'lib', 'f'", reason::LIBRARY),
            ("DO LANGUAGE plpython3u 'x'", reason::UNTRUSTED_LANGUAGE),
            (
                "CREATE FUNCTION f() RETURNS int LANGUAGE plperlu AS 'x'",
                reason::UNTRUSTED_LANGUAGE,
            ),
            ("SET ROLE admin", reason::IDENTITY),
            ("SELECT 1; SET ROLE NONE", reason::IDENTITY),
            ("SELECT set_config('role', 'x', false)", reason::IDENTITY),
            ("BEGIN READ WRITE", reason::READ_ONLY),
            ("SET search_path = public, pg_catalog", reason::SEARCH_PATH),
            (
                "UPDATE pg_settings SET setting = 'off' WHERE name = 'default_transaction_read_only'",
                reason::SETTING_NAME,
            ),
            ("SELECT set_config(name, 'x', false) FROM t", reason::SETTING_NAME),
            ("UPDATE pg_authid SET rolsuper = true", reason::CATALOG),
            (
                "INSERT INTO pg_catalog.pg_db_role_setting VALUES (0, 0, '{}')",
                reason::CATALOG,
            ),
            ("COPY pg_authid FROM STDIN", reason::CATALOG),
            (r#"SELECT U&"x"(1)"#, reason::UNREADABLE_NAME),
            (r#"EXECUTE U&"p""#, reason::UNREADABLE_NAME),
        ] {
            assert_eq!(class(sql), Forbidden(why), "{sql}");
        }
        assert!(matches!(
            class(r#"SELECT U&"pg_read_file"('x')"#),
            Forbidden(_)
        ));
    }

    #[test]
    fn housekeeping_is_never_judged() {
        assert_all(
            &Housekeeping,
            &[
                "",
                "-- only a comment",
                "BEGIN",
                "COMMIT",
                "SHOW work_mem",
                "SET work_mem = '64MB'",
                "RESET ALL",
                "DISCARD ALL",
                "DEALLOCATE p",
                "FETCH 10 FROM c",
                "CLOSE c",
                "LISTEN c",
                "PREPARE q AS SELECT 1",
                "PREPARE q AS SELECT myfn()",
            ],
        );
    }

    #[test]
    fn prepared_statements_are_reported_for_the_session() {
        let effects = |sql: &str| analyze(sql).effects;
        assert_eq!(
            effects("PREPARE q (int) AS DELETE FROM t WHERE a = $1; EXECUTE q(1)"),
            vec![
                Effect::Prepare {
                    name: "q".into(),
                    runs: Judged(Write),
                    audit: "DELETE FROM t WHERE a = $1".into(),
                },
                Effect::Execute { name: "q".into() },
            ]
        );
        assert_eq!(
            effects("PREPARE q AS SELECT 1"),
            vec![Effect::Prepare {
                name: "q".into(),
                runs: Judged(Read),
                audit: "SELECT $1".into(),
            }]
        );
        assert_eq!(
            effects("EXPLAIN ANALYZE EXECUTE \"Q\""),
            vec![Effect::Execute { name: "Q".into() }]
        );
        assert_eq!(effects("EXPLAIN EXECUTE q"), vec![]);
        assert_eq!(class("CREATE TABLE x AS EXECUTE q"), Judged(Schema));
        assert_eq!(
            effects("CREATE TABLE x AS EXECUTE q"),
            vec![Effect::Execute { name: "q".into() }]
        );
        assert_eq!(
            effects("DEALLOCATE PREPARE q"),
            vec![Effect::Deallocate { name: "q".into() }]
        );
        assert_eq!(effects("DEALLOCATE ALL"), vec![Effect::DeallocateAll]);
        assert_eq!(effects("DISCARD ALL"), vec![Effect::DeallocateAll]);
        assert_eq!(effects("DISCARD PLANS"), vec![]);
        assert_eq!(effects("PREPARE q AS SELECT pg_read_file('x')"), vec![]);
    }

    #[test]
    fn unparseable_text_carries_the_parser_message() {
        for sql in ["SELEC 1", "SELECT 1; SELEC 2", "SELECT 'open"] {
            match class(sql) {
                Classified::Unparseable(message) => assert!(!message.is_empty(), "{sql}"),
                other => panic!("{sql}: {other:?}"),
            }
        }
        assert_eq!(
            class("SELECT 1\0"),
            Classified::Unparseable("invalid byte sequence: 0x00".into())
        );
    }

    #[test]
    fn oversized_text_is_refused_unparsed() {
        let sql = format!("SELECT '{}'", "x".repeat(MAX_PARSED_STATEMENT_BYTES));
        assert_eq!(analyze(&sql), refused(Forbidden(reason::TOO_LARGE)));
    }

    #[test]
    fn audit_text_hides_literals_in_every_statement() {
        let analysis =
            analyze("SELECT * FROM t WHERE a = 'secret'; /* x */ INSERT INTO t VALUES (42)");
        assert_eq!(
            analysis.audit,
            "SELECT * FROM t WHERE a = $1; INSERT INTO t VALUES ($1)"
        );
        let many = "SELECT 1;".repeat(10_000);
        assert_eq!(analyze(&many).audit.chars().count(), MAX_AUDIT_CHARS);
    }
}
