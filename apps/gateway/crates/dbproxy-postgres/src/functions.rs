//! What calling a PostgreSQL function can do, as far as the gateway knows.
//!
//! A statement is only a read when every function it calls is known to read
//! and nothing else. The lists are deliberately closed: a function missing
//! from [`PURE`] is not an error, it makes the statement a write, which the
//! policy then judges. The other lists go the other way: [`ADMIN`] functions
//! act on the server itself and [`RUNS_SQL`] ones run SQL handed to them as
//! text, so both count as schema changes; the server-file and `dblink`
//! functions leave the session the gateway governs, so they never run.

use crate::reason;

/// What one function call does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FunctionKind {
    /// Reads, computes, or describes; changes nothing.
    Pure,
    /// Acts on the server itself (other sessions, configuration, WAL,
    /// replication slots, statistics), or runs SQL it is handed as text,
    /// which the gateway cannot check. Judged as a schema change.
    Server,
    /// Reaches past the governed session. The reason is shown to the agent.
    Forbidden(&'static str),
}

/// Functions that read or compute and change nothing: built-in math, text,
/// date, JSON, array, range and aggregate functions, type casts written as
/// calls, and the catalog helpers psql and drivers call to describe a
/// schema. Sorted (a test checks).
///
/// Left out on purpose: anything that writes (`nextval`, `setval`,
/// `pg_notify`), takes locks (`pg_advisory_*`), assigns a transaction id
/// (`txid_current`), changes settings (`set_config`, `setseed`), or runs SQL
/// it is handed as text ([`RUNS_SQL`]). `coalesce`, `greatest`, `least` and
/// `nullif` are syntax, not calls, so they never reach this list.
const PURE: &[&str] = &[
    "abbrev",
    "abs",
    "acos",
    "acosd",
    "acosh",
    "age",
    "any_value",
    "array_agg",
    "array_append",
    "array_cat",
    "array_dims",
    "array_fill",
    "array_length",
    "array_lower",
    "array_ndims",
    "array_position",
    "array_positions",
    "array_prepend",
    "array_remove",
    "array_replace",
    "array_reverse",
    "array_sample",
    "array_shuffle",
    "array_sort",
    "array_to_json",
    "array_to_string",
    "array_to_tsvector",
    "array_upper",
    "ascii",
    "asin",
    "asind",
    "asinh",
    "atan",
    "atan2",
    "atan2d",
    "atand",
    "atanh",
    "avg",
    "bit_and",
    "bit_count",
    "bit_length",
    "bit_or",
    "bit_xor",
    "bool",
    "bool_and",
    "bool_or",
    "broadcast",
    "btrim",
    "cardinality",
    "cbrt",
    "ceil",
    "ceiling",
    "char_length",
    "character_length",
    "chr",
    "clock_timestamp",
    "col_description",
    "concat",
    "concat_ws",
    "convert",
    "convert_from",
    "convert_to",
    "corr",
    "cos",
    "cosd",
    "cosh",
    "cot",
    "cotd",
    "count",
    "covar_pop",
    "covar_samp",
    "cume_dist",
    "current_database",
    "current_query",
    "current_schema",
    "current_schemas",
    "current_setting",
    "currval",
    "date",
    "date_add",
    "date_bin",
    "date_part",
    "date_subtract",
    "date_trunc",
    "daterange",
    "decode",
    "degrees",
    "dense_rank",
    "div",
    "encode",
    "every",
    "exp",
    "extract",
    "factorial",
    "family",
    "first_value",
    "float4",
    "float8",
    "floor",
    "format",
    "format_type",
    "gcd",
    "gen_random_uuid",
    "generate_series",
    "generate_subscripts",
    "get_bit",
    "get_byte",
    "has_any_column_privilege",
    "has_column_privilege",
    "has_database_privilege",
    "has_foreign_data_wrapper_privilege",
    "has_function_privilege",
    "has_language_privilege",
    "has_parameter_privilege",
    "has_schema_privilege",
    "has_sequence_privilege",
    "has_server_privilege",
    "has_table_privilege",
    "has_tablespace_privilege",
    "has_type_privilege",
    "host",
    "hostmask",
    "inet_client_addr",
    "inet_client_port",
    "inet_server_addr",
    "inet_server_port",
    "initcap",
    "int2",
    "int4",
    "int4range",
    "int8",
    "int8range",
    "interval",
    "is_normalized",
    "isempty",
    "isfinite",
    "json_agg",
    "json_agg_strict",
    "json_array_elements",
    "json_array_elements_text",
    "json_array_length",
    "json_build_array",
    "json_build_object",
    "json_each",
    "json_each_text",
    "json_extract_path",
    "json_extract_path_text",
    "json_object",
    "json_object_agg",
    "json_object_keys",
    "json_populate_record",
    "json_populate_recordset",
    "json_strip_nulls",
    "json_to_record",
    "json_to_recordset",
    "json_typeof",
    "jsonb_agg",
    "jsonb_agg_strict",
    "jsonb_array_elements",
    "jsonb_array_elements_text",
    "jsonb_array_length",
    "jsonb_build_array",
    "jsonb_build_object",
    "jsonb_each",
    "jsonb_each_text",
    "jsonb_extract_path",
    "jsonb_extract_path_text",
    "jsonb_insert",
    "jsonb_object",
    "jsonb_object_agg",
    "jsonb_object_keys",
    "jsonb_path_exists",
    "jsonb_path_match",
    "jsonb_path_query",
    "jsonb_path_query_array",
    "jsonb_path_query_first",
    "jsonb_populate_record",
    "jsonb_populate_recordset",
    "jsonb_pretty",
    "jsonb_set",
    "jsonb_set_lax",
    "jsonb_strip_nulls",
    "jsonb_to_record",
    "jsonb_to_recordset",
    "jsonb_typeof",
    "justify_days",
    "justify_hours",
    "justify_interval",
    "lag",
    "last_value",
    "lastval",
    "lcm",
    "lead",
    "left",
    "length",
    "like_escape",
    "ln",
    "log",
    "log10",
    "lower",
    "lower_inc",
    "lower_inf",
    "lpad",
    "ltrim",
    "make_date",
    "make_interval",
    "make_time",
    "make_timestamp",
    "make_timestamptz",
    "masklen",
    "max",
    "md5",
    "min",
    "min_scale",
    "mod",
    "mode",
    "netmask",
    "network",
    "normalize",
    "now",
    "nth_value",
    "ntile",
    "num_nonnulls",
    "num_nulls",
    "numeric",
    "numrange",
    "obj_description",
    "octet_length",
    "oidvectortypes",
    "overlaps",
    "overlay",
    "percent_rank",
    "percentile_cont",
    "percentile_disc",
    "pg_backend_pid",
    "pg_blocking_pids",
    "pg_char_to_encoding",
    "pg_client_encoding",
    "pg_collation_for",
    "pg_collation_is_visible",
    "pg_column_is_updatable",
    "pg_column_size",
    "pg_conversion_is_visible",
    "pg_database_size",
    "pg_describe_object",
    "pg_encoding_to_char",
    "pg_function_is_visible",
    "pg_get_constraintdef",
    "pg_get_expr",
    "pg_get_function_arguments",
    "pg_get_function_identity_arguments",
    "pg_get_function_result",
    "pg_get_function_sqlbody",
    "pg_get_functiondef",
    "pg_get_indexdef",
    "pg_get_keywords",
    "pg_get_object_address",
    "pg_get_partition_constraintdef",
    "pg_get_partkeydef",
    "pg_get_publication_tables",
    "pg_get_replica_identity_index",
    "pg_get_ruledef",
    "pg_get_serial_sequence",
    "pg_get_statisticsobjdef",
    "pg_get_statisticsobjdef_columns",
    "pg_get_statisticsobjdef_expressions",
    "pg_get_triggerdef",
    "pg_get_userbyid",
    "pg_get_viewdef",
    "pg_has_role",
    "pg_identify_object",
    "pg_identify_object_as_address",
    "pg_indexes_size",
    "pg_input_error_info",
    "pg_input_is_valid",
    "pg_is_in_recovery",
    "pg_is_other_temp_schema",
    "pg_listening_channels",
    "pg_my_temp_schema",
    "pg_opclass_is_visible",
    "pg_operator_is_visible",
    "pg_opfamily_is_visible",
    "pg_options_to_table",
    "pg_partition_ancestors",
    "pg_partition_root",
    "pg_partition_tree",
    "pg_postmaster_start_time",
    "pg_relation_is_publishable",
    "pg_relation_is_updatable",
    "pg_relation_size",
    "pg_settings_get_flags",
    "pg_size_bytes",
    "pg_size_pretty",
    "pg_sleep",
    "pg_sleep_for",
    "pg_sleep_until",
    "pg_statistics_obj_is_visible",
    "pg_table_is_visible",
    "pg_table_size",
    "pg_tablespace_location",
    "pg_tablespace_size",
    "pg_total_relation_size",
    "pg_ts_config_is_visible",
    "pg_ts_dict_is_visible",
    "pg_ts_parser_is_visible",
    "pg_ts_template_is_visible",
    "pg_type_is_visible",
    "pg_typeof",
    "phraseto_tsquery",
    "pi",
    "plainto_tsquery",
    "position",
    "pow",
    "power",
    "quote_ident",
    "quote_literal",
    "quote_nullable",
    "radians",
    "random",
    "random_normal",
    "range_agg",
    "range_intersect_agg",
    "range_merge",
    "rank",
    "regexp_count",
    "regexp_instr",
    "regexp_like",
    "regexp_match",
    "regexp_matches",
    "regexp_replace",
    "regexp_split_to_array",
    "regexp_split_to_table",
    "regexp_substr",
    "regr_avgx",
    "regr_avgy",
    "regr_count",
    "regr_intercept",
    "regr_r2",
    "regr_slope",
    "regr_sxx",
    "regr_sxy",
    "regr_syy",
    "repeat",
    "replace",
    "reverse",
    "right",
    "round",
    "row_number",
    "row_to_json",
    "rpad",
    "rtrim",
    "scale",
    "setweight",
    "sha224",
    "sha256",
    "sha384",
    "sha512",
    "shobj_description",
    "sign",
    "similar_escape",
    "similar_to_escape",
    "sin",
    "sind",
    "sinh",
    "split_part",
    "sqrt",
    "starts_with",
    "statement_timestamp",
    "stddev",
    "stddev_pop",
    "stddev_samp",
    "string_agg",
    "string_to_array",
    "string_to_table",
    "strpos",
    "substr",
    "substring",
    "sum",
    "system_user",
    "tan",
    "tand",
    "tanh",
    "text",
    "time",
    "timeofday",
    "timestamp",
    "timestamptz",
    "timezone",
    "to_char",
    "to_date",
    "to_hex",
    "to_json",
    "to_jsonb",
    "to_number",
    "to_regclass",
    "to_regcollation",
    "to_regnamespace",
    "to_regoper",
    "to_regoperator",
    "to_regproc",
    "to_regprocedure",
    "to_regrole",
    "to_regtype",
    "to_regtypemod",
    "to_timestamp",
    "to_tsquery",
    "to_tsvector",
    "transaction_timestamp",
    "translate",
    "trim_array",
    "trim_scale",
    "trunc",
    "ts_headline",
    "ts_rank",
    "ts_rank_cd",
    "tsrange",
    "tstzrange",
    "unistr",
    "unnest",
    "upper",
    "upper_inc",
    "upper_inf",
    "uuid_extract_timestamp",
    "uuid_extract_version",
    "uuidv4",
    "uuidv7",
    "var_pop",
    "var_samp",
    "varchar",
    "variance",
    "version",
    "websearch_to_tsquery",
    "width_bucket",
    "xml_is_well_formed",
    "xml_is_well_formed_content",
    "xml_is_well_formed_document",
    "xmlagg",
    "xmlexists",
    "xpath",
    "xpath_exists",
];

/// Functions that act on the server rather than the data: ending other
/// sessions, reloading configuration, WAL and backup control, replication
/// slots, resetting statistics. Sorted.
const ADMIN: &[&str] = &[
    "pg_backup_start",
    "pg_backup_stop",
    "pg_cancel_backend",
    "pg_copy_logical_replication_slot",
    "pg_copy_physical_replication_slot",
    "pg_create_logical_replication_slot",
    "pg_create_physical_replication_slot",
    "pg_create_restore_point",
    "pg_drop_replication_slot",
    "pg_import_system_collations",
    "pg_log_backend_memory_contexts",
    "pg_logical_emit_message",
    "pg_logical_slot_get_binary_changes",
    "pg_logical_slot_get_changes",
    "pg_logical_slot_peek_binary_changes",
    "pg_logical_slot_peek_changes",
    "pg_promote",
    "pg_reload_conf",
    "pg_replication_slot_advance",
    "pg_rotate_logfile",
    "pg_start_backup",
    "pg_stat_reset",
    "pg_stat_reset_replication_slot",
    "pg_stat_reset_shared",
    "pg_stat_reset_single_function_counters",
    "pg_stat_reset_single_table_counters",
    "pg_stat_reset_slru",
    "pg_stat_reset_subscription_stats",
    "pg_stop_backup",
    "pg_switch_wal",
    "pg_terminate_backend",
    "pg_wal_replay_pause",
    "pg_wal_replay_resume",
];

/// Functions (built in, or from `tablefunc` and `xml2`) that run SQL they
/// are handed as text. The gateway never sees that SQL, so the call is as
/// powerful as any statement. Sorted.
const RUNS_SQL: &[&str] = &[
    "connectby",
    "crosstab",
    "crosstab2",
    "crosstab3",
    "crosstab4",
    "cursor_to_xml",
    "cursor_to_xmlschema",
    "query_to_xml",
    "query_to_xml_and_xmlschema",
    "query_to_xmlschema",
    "ts_rewrite",
    "ts_stat",
    "xpath_table",
];

/// Functions that read or write the server's files. Sorted.
const SERVER_FILE_FUNCTIONS: &[&str] = &[
    "lo_export",
    "lo_import",
    "pg_file_rename",
    "pg_file_sync",
    "pg_file_unlink",
    "pg_file_write",
    "pg_logdir_ls",
    "pg_ls_archive_statusdir",
    "pg_ls_dir",
    "pg_ls_logdir",
    "pg_ls_logicalmapdir",
    "pg_ls_logicalsnapdir",
    "pg_ls_replslotdir",
    "pg_ls_summariesdir",
    "pg_ls_tmpdir",
    "pg_ls_waldir",
    "pg_read_binary_file",
    "pg_read_file",
    "pg_stat_file",
];

/// What calling `schema.name(...)` does, or `None` when the gateway does not
/// know the function (the caller then treats the statement as a write).
///
/// Built-in reads count only when unqualified or qualified with
/// `pg_catalog`: `public.lower()` is somebody's own function. The other
/// lists apply under any schema, since extensions (`dblink`, `tablefunc`)
/// install into whichever schema the operator chose. Every `dblink*` name is
/// forbidden, so a function the extension adds later is covered too.
#[must_use]
pub fn kind(schema: Option<&str>, name: &str) -> Option<FunctionKind> {
    if name.starts_with("dblink") {
        return Some(FunctionKind::Forbidden(reason::OTHER_SERVERS));
    }
    if SERVER_FILE_FUNCTIONS.binary_search(&name).is_ok() {
        return Some(FunctionKind::Forbidden(reason::SERVER_FILES));
    }
    if ADMIN.binary_search(&name).is_ok() || RUNS_SQL.binary_search(&name).is_ok() {
        return Some(FunctionKind::Server);
    }
    let builtin = matches!(schema, None | Some("pg_catalog"));
    (builtin && PURE.binary_search(&name).is_ok()).then_some(FunctionKind::Pure)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_list_is_sorted_unique_and_disjoint() {
        let lists = [
            ("PURE", PURE),
            ("ADMIN", ADMIN),
            ("RUNS_SQL", RUNS_SQL),
            ("SERVER_FILE_FUNCTIONS", SERVER_FILE_FUNCTIONS),
        ];
        for (name, list) in lists {
            assert!(
                list.windows(2).all(|w| w[0] < w[1]),
                "{name} must be sorted and unique for binary search"
            );
        }
        for (i, (a, first)) in lists.iter().enumerate() {
            for (b, second) in &lists[i + 1..] {
                for function in *first {
                    assert!(
                        second.binary_search(function).is_err(),
                        "{function} in {a} and {b}"
                    );
                }
            }
        }
        assert!(lists
            .iter()
            .flat_map(|(_, l)| *l)
            .all(|f| !f.starts_with("dblink")));
    }

    #[test]
    fn built_in_reads_count_only_in_pg_catalog() {
        assert_eq!(kind(None, "lower"), Some(FunctionKind::Pure));
        assert_eq!(kind(Some("pg_catalog"), "lower"), Some(FunctionKind::Pure));
        assert_eq!(kind(Some("public"), "lower"), None);
        assert_eq!(
            kind(None, "LOWER"),
            None,
            "a quoted name is another function"
        );
    }

    #[test]
    fn writes_and_unknown_functions_are_not_reads() {
        for name in [
            "nextval",
            "setval",
            "pg_notify",
            "pg_advisory_lock",
            "txid_current",
            "set_config",
            "setseed",
            "my_function",
        ] {
            assert_eq!(kind(None, name), None, "{name}");
        }
    }

    #[test]
    fn server_files_and_other_servers_are_forbidden_under_any_schema() {
        for (schema, name, why) in [
            (None, "pg_read_file", reason::SERVER_FILES),
            (Some("pg_catalog"), "lo_import", reason::SERVER_FILES),
            (Some("public"), "dblink_exec", reason::OTHER_SERVERS),
            (None, "dblink", reason::OTHER_SERVERS),
        ] {
            assert_eq!(
                kind(schema, name),
                Some(FunctionKind::Forbidden(why)),
                "{name}"
            );
        }
    }

    #[test]
    fn administration_and_sql_runners_act_on_the_server_under_any_schema() {
        assert_eq!(
            kind(None, "pg_terminate_backend"),
            Some(FunctionKind::Server)
        );
        assert_eq!(
            kind(Some("public"), "pg_reload_conf"),
            Some(FunctionKind::Server)
        );
        assert_eq!(kind(None, "query_to_xml"), Some(FunctionKind::Server));
        assert_eq!(kind(Some("ext"), "crosstab"), Some(FunctionKind::Server));
    }
}
