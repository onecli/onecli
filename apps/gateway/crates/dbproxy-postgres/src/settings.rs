//! The settings no statement may move, and the values it may move them to.
//!
//! Four groups of server settings are guarded whatever the policy says:
//!
//! - **identity** (`role`, `session_authorization`): switching them runs the
//!   session as another database role. A DBA may pin a login to a narrower
//!   role (`ALTER ROLE login SET role = narrow`); `SET ROLE NONE` would step
//!   back out to the login role, so it is refused too;
//! - **read-only transactions** (`default_transaction_read_only`,
//!   `transaction_read_only`): a connection's role may be configured
//!   read-only as its own guard, and turning that off would undo it;
//! - **parsing** (`client_encoding`, `standard_conforming_strings`): the
//!   gateway pins both at login so it splits SQL text into tokens exactly as
//!   the server does; moving them would let a statement read differently to
//!   each;
//! - **`search_path`** must not put a schema ahead of `pg_catalog`, where a
//!   function could stand in for a built-in the classifier trusts as a read.
//!
//! A change is allowed only when it provably keeps the guard: setting a value
//! the guard accepts, or resetting it. In this session a reset returns a
//! setting to the value the role, database or login gave it, so it is safe.
//! Stored defaults (`ALTER ROLE ... SET`, `ALTER DATABASE ... SET`) are the
//! other way round: resetting one removes the guard for every later session.
//! Anything the gateway cannot read exactly is refused, never guessed.

use pg_query::protobuf::{a_const, node::Node, Token, VariableSetKind, VariableSetStmt};
use pg_query::NodeEnum;

use crate::reason;
use crate::tokens::Tokens;

/// The longest function definition whose settings are checked from its full
/// parse tree. Larger ones that attach settings are refused: a full parse
/// costs far more than the summary the classifier otherwise uses.
const MAX_FUNCTION_PARSE_BYTES: usize = 64 * 1024;

/// Where a setting change lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    /// This session (`SET`, `RESET`, `set_config`).
    Session,
    /// A stored default for later sessions (`ALTER ROLE` / `ALTER DATABASE`).
    Stored,
    /// A function's own settings, applied while it runs.
    Function,
}

/// What a statement does to one setting.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Change {
    /// Sets this value, as the server would store it; `None` when the
    /// gateway cannot read it.
    Value(Option<String>),
    /// `RESET` / `SET ... TO DEFAULT` (in a stored default: removes it).
    Reset,
    /// `SET ... FROM CURRENT`.
    FromCurrent,
}

/// Why a `SET`, `RESET`, `BEGIN`, `START TRANSACTION`, `ALTER ROLE ... SET`
/// or `ALTER DATABASE ... SET` statement is refused, or `None` when it keeps
/// every guard. Parses the statement fully, which is cheap here: these
/// statements hold only flat lists of literals.
#[must_use]
pub fn check_statement(text: &str) -> Option<&'static str> {
    match single_statement(text) {
        Some(NodeEnum::VariableSetStmt(set)) => check_set(&set, Scope::Session),
        Some(NodeEnum::TransactionStmt(transaction)) => {
            check_transaction_modes(&transaction.options)
        }
        Some(NodeEnum::AlterRoleSetStmt(alter)) => stored(alter.setstmt.as_ref()),
        Some(NodeEnum::AlterDatabaseSetStmt(alter)) => stored(alter.setstmt.as_ref()),
        _ => Some(reason::UNCHECKABLE),
    }
}

/// Why a `CREATE FUNCTION` / `ALTER FUNCTION` statement's `SET` clauses are
/// refused, or `None` when they keep every guard.
#[must_use]
pub fn check_function(text: &str) -> Option<&'static str> {
    if text.len() > MAX_FUNCTION_PARSE_BYTES {
        return Some(reason::UNCHECKABLE);
    }
    let options = match single_statement(text) {
        Some(NodeEnum::CreateFunctionStmt(create)) => create.options,
        Some(NodeEnum::AlterFunctionStmt(alter)) => alter.actions,
        _ => return Some(reason::UNCHECKABLE),
    };
    options
        .iter()
        .find_map(|option| match option.node.as_ref() {
            Some(Node::DefElem(elem)) if elem.defname == "set" => match elem.arg.as_deref() {
                Some(pg_query::protobuf::Node {
                    node: Some(Node::VariableSetStmt(set)),
                }) => check_set(set, Scope::Function),
                _ => Some(reason::UNCHECKABLE),
            },
            _ => None,
        })
}

/// Why a `set_config(name, value, is_local)` call whose name token is at
/// `at` is refused, or `None` when it keeps every guard. The name must be a
/// plain string literal in positional form; otherwise the gateway cannot
/// tell which setting moves.
#[must_use]
pub fn check_set_config(tokens: &Tokens<'_>, at: usize) -> Option<&'static str> {
    let argument = |i: usize| {
        tokens
            .string(i)
            .filter(|_| tokens.is(i + 1, Token::Ascii44))
    };
    let Some(name) = argument(at + 2) else {
        return Some(reason::SETTING_NAME);
    };
    verdict(
        &name.to_ascii_lowercase(),
        &Change::Value(argument(at + 4)),
        Scope::Session,
    )
}

/// Why a startup parameter (`name=value` in the client's startup packet,
/// which the server applies like `SET` at login) is refused, or `None` when
/// it keeps every guard.
#[must_use]
pub fn check_startup_parameter(name: &str, value: &str) -> Option<&'static str> {
    verdict(
        &name.to_ascii_lowercase(),
        &Change::Value(Some(value.to_string())),
        Scope::Session,
    )
}

/// Whether a data change to `schema.table` changes settings: the
/// `pg_settings` view turns updates into `set_config` calls. Unqualified
/// names resolve to it too, since `pg_catalog` is searched first.
#[must_use]
pub fn is_settings_view(schema: &str, table: &str) -> bool {
    table == "pg_settings" && matches!(schema, "" | "pg_catalog")
}

/// The one statement `text` holds, fully parsed.
fn single_statement(text: &str) -> Option<NodeEnum> {
    let parsed = pg_query::parse(text).ok()?;
    let [raw] = parsed.protobuf.stmts.as_slice() else {
        return None;
    };
    raw.stmt.as_ref()?.node.clone()
}

fn stored(set: Option<&VariableSetStmt>) -> Option<&'static str> {
    set.map_or(Some(reason::UNCHECKABLE), |set| {
        check_set(set, Scope::Stored)
    })
}

fn check_set(set: &VariableSetStmt, scope: Scope) -> Option<&'static str> {
    let name = set.name.to_ascii_lowercase();
    let change = match VariableSetKind::try_from(set.kind) {
        Ok(VariableSetKind::VarSetValue) => Change::Value(value(&name, &set.args)),
        Ok(VariableSetKind::VarSetDefault | VariableSetKind::VarReset) => Change::Reset,
        Ok(VariableSetKind::VarSetCurrent) => Change::FromCurrent,
        // `RESET ALL` restores this session's guards (and a function's), but
        // on a stored default it drops every one of them.
        Ok(VariableSetKind::VarResetAll) => {
            return (scope == Scope::Stored).then_some(reason::STORED_SETTINGS);
        }
        Ok(VariableSetKind::VarSetMulti) => return check_transaction_modes(&set.args),
        Ok(VariableSetKind::Undefined) | Err(_) => return Some(reason::UNCHECKABLE),
    };
    verdict(&name, &change, scope)
}

/// `BEGIN ...`, `SET TRANSACTION ...` and `SET SESSION CHARACTERISTICS AS
/// TRANSACTION ...`: refused when a mode turns read-only off (`READ WRITE`).
fn check_transaction_modes(args: &[pg_query::protobuf::Node]) -> Option<&'static str> {
    let read_write = args.iter().any(|arg| match arg.node.as_ref() {
        Some(Node::DefElem(elem)) if elem.defname == "transaction_read_only" => !elem
            .arg
            .as_deref()
            .and_then(literal)
            .as_deref()
            .is_some_and(is_true),
        _ => false,
    });
    read_write.then_some(reason::READ_ONLY)
}

/// The one rule every route to a setting goes through.
fn verdict(name: &str, change: &Change, scope: Scope) -> Option<&'static str> {
    match name {
        "role" | "session_authorization" => match (change, scope) {
            // Back to what the login, its role and database configured.
            (Change::Reset, Scope::Session | Scope::Function) => None,
            (Change::FromCurrent, Scope::Session | Scope::Function) => None,
            _ => Some(reason::IDENTITY),
        },
        "default_transaction_read_only" | "transaction_read_only" => match (change, scope) {
            (Change::Value(Some(value)), _) if is_true(value) => None,
            (Change::Reset | Change::FromCurrent, Scope::Session | Scope::Function) => None,
            _ => Some(reason::READ_ONLY),
        },
        // The login pins both, overriding stored defaults; a function's own
        // value lasts only while it runs, and changes nothing the gateway
        // reads.
        "client_encoding" | "standard_conforming_strings" if scope == Scope::Session => {
            match change {
                Change::Reset | Change::FromCurrent => None,
                Change::Value(Some(value)) if keeps_pinned(name, value) => None,
                Change::Value(_) => Some(reason::PARSING),
            }
        }
        // A function's own path decides only what its body resolves, which
        // the gateway never classifies.
        "search_path" if scope != Scope::Function => match change {
            Change::Reset | Change::FromCurrent => None,
            Change::Value(Some(value)) if catalog_stays_first(value) => None,
            Change::Value(_) => Some(reason::SEARCH_PATH),
        },
        _ => None,
    }
}

/// The value a `SET name = args` stores, as text. A list setting
/// (`search_path`) stores each element as a quoted identifier, the way the
/// server flattens it; every other setting takes one literal.
fn value(name: &str, args: &[pg_query::protobuf::Node]) -> Option<String> {
    if name == "search_path" {
        let items: Option<Vec<String>> = args
            .iter()
            .map(|arg| literal(arg).map(|item| format!("\"{}\"", item.replace('"', "\"\""))))
            .collect();
        return items.map(|items| items.join(", "));
    }
    match args {
        [arg] => literal(arg),
        _ => None,
    }
}

/// Whether `value` is the one the login pinned for `name`.
fn keeps_pinned(name: &str, value: &str) -> bool {
    if name == "standard_conforming_strings" {
        return is_true(value);
    }
    // The server compares encoding names ignoring case and everything but
    // letters and digits (`clean_encoding_name`).
    let clean: String = value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    matches!(clean.as_str(), "utf8" | "unicode")
}

/// Whether a `search_path` value leaves `pg_catalog` searched first: it is
/// either absent (the server then searches it first implicitly) or the
/// first entry. An unreadable value fails. (`pg_temp` is never searched for
/// functions; a temporary table that shadows a `pg_` name only makes the
/// classifier refuse more, since it treats unqualified `pg_` writes as
/// catalog writes.)
fn catalog_stays_first(value: &str) -> bool {
    split_identifiers(value)
        .is_some_and(|schemas| schemas.iter().skip(1).all(|schema| schema != "pg_catalog"))
}

/// A comma-separated identifier list as the server splits it
/// (`SplitIdentifierString`): unquoted names folded to lower case, quoted
/// ones verbatim with `""` as a quote. `None` when malformed.
fn split_identifiers(value: &str) -> Option<Vec<String>> {
    let mut schemas = Vec::new();
    let mut chars = value.trim_start().chars().peekable();
    if chars.peek().is_none() {
        return Some(schemas);
    }
    loop {
        let mut schema = String::new();
        if chars.next_if_eq(&'"').is_some() {
            loop {
                match chars.next()? {
                    '"' if chars.next_if_eq(&'"').is_some() => schema.push('"'),
                    '"' => break,
                    c => schema.push(c),
                }
            }
        } else {
            while let Some(c) = chars.next_if(|c| *c != ',' && !c.is_whitespace()) {
                schema.push(c.to_ascii_lowercase());
            }
            if schema.is_empty() {
                return None;
            }
        }
        schemas.push(schema);
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        match chars.next() {
            None => return Some(schemas),
            Some(',') => while chars.next_if(|c| c.is_whitespace()).is_some() {},
            Some(_) => return None,
        }
    }
}

/// Whether the server reads `value` as boolean true: `1`, `on`, or any
/// prefix of `true` or `yes`, ignoring case (`parse_bool`).
fn is_true(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value == "1"
        || value == "on"
        || (!value.is_empty() && ("true".starts_with(&value) || "yes".starts_with(&value)))
}

fn literal(node: &pg_query::protobuf::Node) -> Option<String> {
    let Some(Node::AConst(constant)) = node.node.as_ref() else {
        return None;
    };
    match constant.val.as_ref()? {
        a_const::Val::Sval(s) => Some(s.sval.clone()),
        a_const::Val::Ival(i) => Some(i.ival.to_string()),
        a_const::Val::Fval(f) => Some(f.fval.clone()),
        a_const::Val::Boolval(b) => Some(b.boolval.to_string()),
        a_const::Val::Bsval(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(sql: &str) -> Option<&'static str> {
        check_statement(sql)
    }

    #[test]
    fn identity_may_only_return_to_what_the_login_configured() {
        for sql in [
            "SET ROLE admin",
            "SET LOCAL ROLE 'admin'",
            // Steps out of a role the DBA pinned the login to.
            "SET ROLE NONE",
            "SET role = 'none'",
            r#"SET "Role" = admin"#,
            r#"SET U&"r!006Fle" UESCAPE '!' = admin"#,
            "SET SESSION AUTHORIZATION admin",
            "ALTER ROLE me SET role = admin",
            "ALTER ROLE me SET role FROM CURRENT",
            // Drops the pin for every later session.
            "ALTER ROLE me RESET role",
            "ALTER DATABASE d SET role = admin",
        ] {
            assert_eq!(check(sql), Some(reason::IDENTITY), "{sql}");
        }
        for sql in [
            "RESET ROLE",
            "SET role TO DEFAULT",
            "SET role FROM CURRENT",
            "SET SESSION AUTHORIZATION DEFAULT",
            "RESET SESSION AUTHORIZATION",
        ] {
            assert_eq!(check(sql), None, "{sql}");
        }
    }

    #[test]
    fn read_only_may_only_be_turned_on_or_restored() {
        for sql in [
            "SET default_transaction_read_only = off",
            "SET default_transaction_read_only = 0",
            "SET default_transaction_read_only = 'of'",
            "SET transaction_read_only = false",
            "SET default_transaction_read_only = 1.0",
            "SET TRANSACTION READ WRITE",
            "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ WRITE",
            "BEGIN READ WRITE",
            "BEGIN READ ONLY, READ WRITE",
            "START TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE",
            "ALTER ROLE me SET default_transaction_read_only = off",
            "ALTER ROLE me RESET default_transaction_read_only",
            "ALTER DATABASE d SET default_transaction_read_only TO DEFAULT",
        ] {
            assert_eq!(check(sql), Some(reason::READ_ONLY), "{sql}");
        }
        for sql in [
            "ALTER ROLE me IN DATABASE d RESET ALL",
            "ALTER DATABASE d RESET ALL",
        ] {
            assert_eq!(check(sql), Some(reason::STORED_SETTINGS), "{sql}");
        }
        for sql in [
            "SET default_transaction_read_only = on",
            "SET default_transaction_read_only = 'TRU'",
            "SET default_transaction_read_only = y",
            "SET default_transaction_read_only = 1",
            "SET default_transaction_read_only TO DEFAULT",
            "RESET default_transaction_read_only",
            "SET transaction_read_only FROM CURRENT",
            "RESET ALL",
            "SET TRANSACTION READ ONLY",
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
            "SET TRANSACTION SNAPSHOT '00000003-0000001B-1'",
            "ALTER ROLE me SET default_transaction_read_only = on",
            "BEGIN",
            "BEGIN ISOLATION LEVEL READ COMMITTED, READ ONLY",
            "START TRANSACTION DEFERRABLE",
            "COMMIT AND CHAIN",
            "PREPARE TRANSACTION 'g'",
        ] {
            assert_eq!(check(sql), None, "{sql}");
        }
    }

    #[test]
    fn parsing_settings_keep_their_pinned_values() {
        for sql in [
            "SET client_encoding = 'SQL_ASCII'",
            "SET NAMES 'LATIN1'",
            "SET standard_conforming_strings = off",
            "SET client_encoding = 'UTF8', 'x'",
        ] {
            assert_eq!(check(sql), Some(reason::PARSING), "{sql}");
        }
        for sql in [
            "SET client_encoding = 'UTF8'",
            "SET NAMES 'utf-8'",
            "SET client_encoding = unicode",
            "SET NAMES",
            "RESET client_encoding",
            "SET standard_conforming_strings = on",
            "ALTER ROLE me SET client_encoding = 'LATIN1'",
        ] {
            assert_eq!(check(sql), None, "{sql}");
        }
    }

    #[test]
    fn search_path_keeps_the_catalog_first() {
        for sql in [
            "SET search_path = public, pg_catalog",
            "SET search_path = public, PG_CATALOG",
            "SET search_path TO public, 'pg_catalog'",
            "SET search_path = pg_temp, pg_catalog",
            "ALTER ROLE me SET search_path = app, pg_catalog",
        ] {
            assert_eq!(check(sql), Some(reason::SEARCH_PATH), "{sql}");
        }
        for sql in [
            "SET search_path = public",
            "SET search_path = pg_catalog, public",
            "SET search_path = \"$user\", public",
            "SET search_path = public, 'PG_CATALOG'",
            "SET search_path = ''",
            "SET search_path TO DEFAULT",
            "RESET search_path",
        ] {
            assert_eq!(check(sql), None, "{sql}");
        }
    }

    /// A client's startup packet sets parameters before its first
    /// statement, so they keep the same guards as `SET`.
    #[test]
    fn startup_parameters_keep_the_guards() {
        for (name, value) in [
            ("search_path", "evil, pg_catalog"),
            ("search_path", "a,\"pg_catalog\""),
            ("search_path", "a, \"unterminated"),
        ] {
            assert_eq!(
                check_startup_parameter(name, value),
                Some(reason::SEARCH_PATH),
                "{value}"
            );
        }
        for (name, value) in [
            ("search_path", "app, public"),
            ("search_path", "pg_catalog, app"),
            ("search_path", "\"$user\", public"),
            ("TimeZone", "Europe/Berlin"),
            ("DateStyle", "ISO, DMY"),
        ] {
            assert_eq!(check_startup_parameter(name, value), None, "{value}");
        }
    }

    #[test]
    fn other_settings_are_free() {
        for sql in [
            "SET TIME ZONE INTERVAL '1' HOUR TO MINUTE",
            "SET application_name = 'x'",
            "SET a.b = 1",
            "SET statement_timeout = '5s'",
            "ALTER ROLE me SET work_mem = '64MB'",
        ] {
            assert_eq!(check(sql), None, "{sql}");
        }
    }

    #[test]
    fn function_settings_keep_identity_and_read_only() {
        for (sql, want) in [
            (
                "CREATE FUNCTION f() RETURNS int LANGUAGE sql SET role = admin AS 'select 1'",
                Some(reason::IDENTITY),
            ),
            ("ALTER FUNCTION f() SET search_path = a RESET role", None),
            (
                "ALTER FUNCTION f() SET default_transaction_read_only = off",
                Some(reason::READ_ONLY),
            ),
            (
                "CREATE FUNCTION f() RETURNS int LANGUAGE sql SET search_path = public, pg_catalog AS 'select 1'",
                None,
            ),
            ("ALTER PROCEDURE p() RESET ALL", None),
            ("ALTER FUNCTION f() SET client_encoding = 'LATIN1'", None),
        ] {
            assert_eq!(check_function(sql), want, "{sql}");
        }
        let large = format!(
            "CREATE FUNCTION f() RETURNS int LANGUAGE sql SET search_path = a AS '{}'",
            "x".repeat(MAX_FUNCTION_PARSE_BYTES)
        );
        assert_eq!(check_function(&large), Some(reason::UNCHECKABLE));
    }

    #[test]
    fn set_config_needs_literal_names_and_keeps_the_guards() {
        let cases = [
            (
                "SELECT set_config('role', 'admin', false)",
                Some(reason::IDENTITY),
            ),
            (
                "SELECT set_config('ROLE', 'none', false)",
                Some(reason::IDENTITY),
            ),
            (
                "SELECT set_config('default_transaction_read_only', 'off', false)",
                Some(reason::READ_ONLY),
            ),
            (
                "SELECT set_config('default_transaction_read_only', 'on', false)",
                None,
            ),
            (
                "SELECT set_config('transaction_read_only', 'o' || 'ff', true)",
                Some(reason::READ_ONLY),
            ),
            (
                "SELECT set_config('client_encoding', 'LATIN1', false)",
                Some(reason::PARSING),
            ),
            (
                "SELECT set_config('search_path', 'a, \"pg_catalog\"', false)",
                Some(reason::SEARCH_PATH),
            ),
            (
                "SELECT set_config('search_path', 'pg_catalog, a', false)",
                None,
            ),
            ("SELECT set_config('statement_timeout', '5s', false)", None),
            (
                "SELECT set_config('ro' || 'le', 'x', false)",
                Some(reason::SETTING_NAME),
            ),
            (
                "SELECT set_config(E'role', 'x', false)",
                Some(reason::SETTING_NAME),
            ),
            (
                "SELECT set_config('ro'\n'le', 'x', false)",
                Some(reason::SETTING_NAME),
            ),
            (
                "SELECT set_config(setting_name => 'role', new_value => 'x', is_local => false)",
                Some(reason::SETTING_NAME),
            ),
            (
                "SELECT set_config(name, 'x', false) FROM t",
                Some(reason::SETTING_NAME),
            ),
        ];
        for (sql, want) in cases {
            let tokens = Tokens::scan(sql).unwrap();
            let call = tokens
                .calls()
                .find(|c| c.name.as_deref() == Some("set_config"))
                .unwrap();
            assert_eq!(check_set_config(&tokens, call.at), want, "{sql}");
        }
    }

    #[test]
    fn only_the_catalog_settings_view_is_guarded() {
        assert!(is_settings_view("", "pg_settings"));
        assert!(is_settings_view("pg_catalog", "pg_settings"));
        assert!(!is_settings_view("public", "pg_settings"));
        assert!(!is_settings_view("", "settings"));
    }

    #[test]
    fn identifier_lists_split_like_the_server() {
        let split = |v: &str| split_identifiers(v);
        assert_eq!(split(""), Some(vec![]));
        assert_eq!(split("  A ,b"), Some(vec!["a".into(), "b".into()]));
        assert_eq!(
            split(r#""A""x", b"#),
            Some(vec![r#"A"x"#.into(), "b".into()])
        );
        assert_eq!(split("a,,b"), None);
        assert_eq!(split("a b"), None);
        assert_eq!(split(r#""open"#), None);
    }

    #[test]
    fn booleans_read_like_the_server() {
        for value in ["1", "on", "ON", "t", "tr", "TRUE", "y", "ye", "yes"] {
            assert!(is_true(value), "{value}");
        }
        for value in [
            "0", "o", "of", "off", "f", "false", "n", "no", "", " on", "2", "1.0",
        ] {
            assert!(!is_true(value), "{value}");
        }
    }
}
