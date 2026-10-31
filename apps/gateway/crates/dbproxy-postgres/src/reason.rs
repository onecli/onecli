//! Why the gateway refuses a statement outright, whatever the policy says.
//!
//! Each reason completes the sentence "OneCLI blocked this statement: …",
//! so it names what the statement would do, not a rule id.

/// Reading or writing the database server's own files.
pub const SERVER_FILES: &str = "it reads or writes files on the database server";

/// `COPY ... PROGRAM`.
pub const PROGRAMS: &str = "it runs a program on the database server";

/// `dblink`, foreign servers and user mappings, subscriptions: a connection
/// from the database server to another server.
pub const OTHER_SERVERS: &str = "it connects the database server to another server";

/// A function or `DO` block in a language not known to be sandboxed
/// (`plpython3u`, `plperlu`, ...).
pub const UNTRUSTED_LANGUAGE: &str = "it runs code in a language OneCLI does not know to be \
     sandboxed, which can reach the database server's operating system";

/// `SET ROLE`, `SET SESSION AUTHORIZATION` and their `set_config` forms.
pub const IDENTITY: &str = "it switches the database role this session runs as";

/// Turning off read-only transactions, which a database role may be
/// configured with as its own guard.
pub const READ_ONLY: &str =
    "it can turn off read-only transactions, which the connection's database role may rely on";

/// The two settings that change how the server splits SQL text into tokens.
/// The gateway reads every statement the way the server does only while
/// they keep the values it pinned at login.
pub const PARSING: &str = "it changes how the server reads SQL text (client_encoding or \
     standard_conforming_strings), which OneCLI relies on to check every statement";

/// A setting change the gateway cannot pin to one setting: `set_config`
/// with a computed or escaped name, or an `UPDATE` of `pg_settings`.
pub const SETTING_NAME: &str = "it changes a server setting OneCLI cannot identify; use SET, or \
     set_config with the setting's name as a plain string literal";

/// `ALTER ROLE ... RESET ALL` / `ALTER DATABASE ... RESET ALL`: drops every
/// stored default, including the guards above, for every later session.
pub const STORED_SETTINGS: &str =
    "it removes every stored setting of a role or database, including the ones that keep it safe";

/// A `search_path` that puts another schema ahead of `pg_catalog`, where a
/// function could stand in for a built-in OneCLI trusts as read-only.
pub const SEARCH_PATH: &str = "it puts a schema ahead of pg_catalog in search_path; list \
     pg_catalog first, or leave it out";

/// `ALTER SYSTEM`.
pub const SERVER_CONFIG: &str = "it changes the database server's configuration";

/// A data change to a system catalog (`pg_authid`, `pg_db_role_setting`,
/// ...): it edits roles, settings and objects behind the statements that
/// would be checked.
pub const CATALOG: &str = "it writes a system catalog (a pg_ table) directly; if this is your \
     own table, qualify it with its schema";

/// `LOAD`, and functions in `C` or `internal`, which bind to code in a
/// library on the server.
pub const LIBRARY: &str = "it loads a library into the database server";

/// A function, prepared statement or cursor named in a form the gateway
/// cannot read, such as a Unicode-escaped name (`U&"..."`).
pub const UNREADABLE_NAME: &str = "it names a function, prepared statement or cursor in a form \
     OneCLI cannot read, such as a Unicode-escaped name";

/// Text over the parse limit (see `dbproxy::limits::MAX_PARSED_STATEMENT_BYTES`).
pub const TOO_LARGE: &str = "it is longer than the 1 MiB of SQL text OneCLI checks in one \
     message; load bulk data with COPY ... FROM STDIN, or send smaller batches";

/// The checker itself failed; nothing is sent rather than something unchecked.
pub const UNCHECKABLE: &str = "OneCLI could not check it";

/// The protocol's `FunctionCall` message: a function run by object id, with
/// no SQL text to check.
pub const FUNCTION_CALL: &str = "it uses the protocol's direct function call, which OneCLI \
     cannot check; call the function from a SELECT instead";

/// A session's prepared statements fill the memory OneCLI tracks them in.
pub const TOO_MANY_PREPARED: &str = "this session already holds as many prepared statements as \
     OneCLI tracks; deallocate some first";

/// A protocol statement that runs another prepared statement by name
/// (`EXECUTE name`), bound to a named portal: SQL `FETCH` could run it later
/// against whatever the name then holds.
pub const NAMED_PORTAL_EXECUTE: &str = "it binds a statement that runs another prepared \
     statement by name to a named portal, which OneCLI cannot follow; bind it to the unnamed \
     portal";
