//! GraphQL operation classification (fail-closed).
//!
//! Several providers expose one `POST /graphql` endpoint for both reads and
//! writes. Catalog tools tagged with `graphqlOps` discriminate on the buffered
//! request body: a `query`-tagged tool matches only a document that is
//! PROVABLY a pure query; a `mutation`-tagged tool matches everything else.
//!
//! This is the Rust twin of the API's
//! `packages/api/src/services/policy-translation/graphql.ts` - the two ports
//! MUST stay byte-locked (the shared corpus pins them). Both implement the
//! same minimal document scanner rather than a full GraphQL parser, precisely
//! so no parser-behavior drift can open a gap between the TS
//! reflection/evaluator and this live decision.
//!
//! FAIL-CLOSED LAW - every doubtful input classifies as `Mutation`:
//! - missing / empty body
//! - body that is not a JSON object with a string `query` field (covers
//!   16KB-buffer truncation, which breaks the JSON)
//! - an envelope whose top level does not carry EXACTLY ONE literal
//!   `"query"` key (duplicate keys are a parser differential - we read
//!   last-wins, an upstream might read first-wins - and so is any escape
//!   sequence inside a top-level key)
//! - unparsable / unbalanced GraphQL document
//! - any `mutation` or `subscription` operation ANYWHERE in the document
//!   (even when `operationName` selects a query - the upstream would execute
//!   only the selected op, but we refuse to reason about selection)
//! - any definition that is not a query (shorthand `{`, `query`, `fragment`)
//! - a document with no executable operation
//!
//! The scanner only needs DEFINITION BOUNDARIES, which in GraphQL are
//! top-level (brace-depth 0) constructs. Strings, block strings, and comments
//! are skipped so their contents can never confuse the depth tracking.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphqlOpKind {
    Query,
    Mutation,
}

impl GraphqlOpKind {
    /// The catalog's `graphqlOps` value for this kind.
    pub fn as_catalog_str(self) -> &'static str {
        match self {
            GraphqlOpKind::Query => "query",
            GraphqlOpKind::Mutation => "mutation",
        }
    }
}

/// Classify a raw request body (the JSON envelope `{"query": "..."}`).
/// `Query` only for a provably pure query document; `Mutation` otherwise.
pub fn classify_graphql_body(body: Option<&[u8]>) -> GraphqlOpKind {
    let Some(bytes) = body else {
        return GraphqlOpKind::Mutation;
    };
    if bytes.is_empty() {
        return GraphqlOpKind::Mutation;
    }
    let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return GraphqlOpKind::Mutation;
    };
    let Some(document) = parsed
        .as_object()
        .and_then(|o| o.get("query"))
        .and_then(|q| q.as_str())
    else {
        return GraphqlOpKind::Mutation;
    };
    // Parser-differential guard: serde_json is last-wins on duplicate keys,
    // but an upstream's parser might be first-wins - a duplicate `"query"`
    // key would then execute a different document than the one classified.
    // Demand exactly one LITERAL top-level `"query"` key (an escaped key
    // also fails - legitimate clients never escape it), so the classified
    // document is provably the one every JSON parser extracts. Mirrors the
    // TS twin's `countTopLevelLiteralQueryKeys`.
    if count_top_level_literal_query_keys(bytes) != 1 {
        return GraphqlOpKind::Mutation;
    }
    classify_graphql_document(document)
}

/// Count top-level object keys that are LITERALLY `query` in raw JSON text.
/// Returns -1 (→ fail closed) when any top-level key contains a backslash
/// escape, since a decoded key could then alias `query` without matching
/// literally. Assumes `text` already parsed as a JSON object (checked by the
/// caller), so the scan only needs string/depth tracking, not validation.
fn count_top_level_literal_query_keys(text: &[u8]) -> i32 {
    let mut count: i32 = 0;
    let mut depth: i32 = 0;
    let mut i = 0usize;
    let len = text.len();
    while i < len {
        let c = text[i];
        if c == b'"' {
            let start = i + 1;
            let mut has_escape = false;
            i += 1;
            while i < len && text[i] != b'"' {
                if text[i] == b'\\' {
                    has_escape = true;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if i >= len {
                return -1; // unterminated (can't happen post-parse)
            }
            let value = &text[start..i];
            i += 1; // closing quote
            let mut j = i;
            while j < len && matches!(text[j], b' ' | b'\t' | b'\n' | b'\r') {
                j += 1;
            }
            if depth == 1 && j < len && text[j] == b':' {
                if has_escape {
                    return -1;
                }
                if value == b"query" {
                    count += 1;
                }
            }
            continue;
        }
        if c == b'{' || c == b'[' {
            depth += 1;
        } else if c == b'}' || c == b']' {
            depth -= 1;
        }
        i += 1;
    }
    count
}

/// Classify a GraphQL document string. `Query` iff every definition is a
/// query operation or a fragment, with at least one query operation.
pub fn classify_graphql_document(document: &str) -> GraphqlOpKind {
    let src: Vec<char> = document.chars().collect();
    let len = src.len();
    let mut i = 0usize;
    let mut depth: i64 = 0;
    // Between definitions (at depth 0, before the next definition's first
    // token). The first token of each definition decides its kind.
    let mut expecting_definition = true;
    let mut saw_query_operation = false;

    while i < len {
        let c = src[i];

        // Insignificant characters (GraphQL "ignored tokens").
        if matches!(c, ' ' | '\t' | '\n' | '\r' | ',' | '\u{FEFF}') {
            i += 1;
            continue;
        }
        // Comment: to end of line.
        if c == '#' {
            while i < len && src[i] != '\n' && src[i] != '\r' {
                i += 1;
            }
            continue;
        }
        // Block string: """ ... """ (backslash-escaped `\"""` inside).
        if starts_with(&src, i, &['"', '"', '"']) {
            i += 3;
            while i < len && !starts_with(&src, i, &['"', '"', '"']) {
                i += if src[i] == '\\' && starts_with(&src, i, &['\\', '"', '"', '"']) {
                    4
                } else {
                    1
                };
            }
            if i >= len {
                return GraphqlOpKind::Mutation; // unterminated → fail closed
            }
            i += 3;
            continue;
        }
        // String: " ... " with backslash escapes.
        if c == '"' {
            i += 1;
            while i < len && src[i] != '"' {
                i += if src[i] == '\\' { 2 } else { 1 };
            }
            if i >= len {
                return GraphqlOpKind::Mutation; // unterminated → fail closed
            }
            i += 1;
            continue;
        }

        if expecting_definition && depth == 0 {
            // First token of a definition decides its kind.
            if c == '{' {
                // Anonymous shorthand operation - a query by spec.
                saw_query_operation = true;
                expecting_definition = false;
                depth += 1;
                i += 1;
                continue;
            }
            let Some(word) = read_name(&src, i) else {
                return GraphqlOpKind::Mutation; // not a definition start → fail closed
            };
            i += word.len();
            match word.as_str() {
                "query" => {
                    saw_query_operation = true;
                    expecting_definition = false;
                    continue;
                }
                "fragment" => {
                    expecting_definition = false;
                    continue;
                }
                // mutation, subscription, or anything unknown (incl. future
                // spec additions) → fail closed.
                _ => return GraphqlOpKind::Mutation,
            }
        }

        // Inside a definition (header or selection set): track nesting only.
        if matches!(c, '{' | '(' | '[') {
            depth += 1;
            i += 1;
            continue;
        }
        if matches!(c, '}' | ')' | ']') {
            depth -= 1;
            if depth < 0 {
                return GraphqlOpKind::Mutation; // unbalanced → fail closed
            }
            if depth == 0 && c == '}' {
                expecting_definition = true;
            }
            i += 1;
            continue;
        }
        // Any other token (names, punctuation like `:` `=` `@` `$` `!` `...`,
        // numbers) is part of the definition - skip one character.
        i += 1;
    }

    if depth != 0 {
        return GraphqlOpKind::Mutation; // unbalanced → fail closed
    }
    if !expecting_definition {
        return GraphqlOpKind::Mutation; // dangling header, no body → fail closed
    }
    if saw_query_operation {
        GraphqlOpKind::Query
    } else {
        GraphqlOpKind::Mutation
    }
}

fn starts_with(src: &[char], at: usize, pat: &[char]) -> bool {
    src.len() >= at + pat.len() && &src[at..at + pat.len()] == pat
}

/// Read a GraphQL Name (`[_A-Za-z][_0-9A-Za-z]*`) at `start`, or None.
fn read_name(src: &[char], start: usize) -> Option<String> {
    let is_start = |ch: char| ch == '_' || ch.is_ascii_alphabetic();
    let is_part = |ch: char| ch == '_' || ch.is_ascii_alphanumeric();
    if start >= src.len() || !is_start(src[start]) {
        return None;
    }
    let mut end = start + 1;
    while end < src.len() && is_part(src[end]) {
        end += 1;
    }
    Some(src[start..end].iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(document: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "query": document })).unwrap()
    }

    fn classify(document: &str) -> GraphqlOpKind {
        classify_graphql_body(Some(&body(document)))
    }

    // ── The pure-query arm (the ONLY way to reach Query) ─────────────────

    #[test]
    fn pure_queries_classify_as_query() {
        assert_eq!(classify("query { viewer { login } }"), GraphqlOpKind::Query);
        assert_eq!(classify("{ viewer { login } }"), GraphqlOpKind::Query);
        assert_eq!(
            classify("query Named($n: Int!) @cached { repos(first: $n) { name } }"),
            GraphqlOpKind::Query
        );
        // Multiple queries + fragments are still pure.
        assert_eq!(
            classify(
                "query A { viewer { ...F } } query B { rateLimit { cost } } \
                 fragment F on User { login }"
            ),
            GraphqlOpKind::Query
        );
        // gh CLI-style: leading comment + BOM-ish whitespace + commas.
        assert_eq!(
            classify("# list PRs\nquery { repository(owner: \"o\", name: \"r\") { pullRequests(first: 10) { nodes { title } } } }"),
            GraphqlOpKind::Query
        );
    }

    #[test]
    fn braces_inside_strings_do_not_confuse_the_scanner() {
        assert_eq!(
            classify(r#"query { search(query: "mutation { } } }", first: 1) { count } }"#),
            GraphqlOpKind::Query
        );
        assert_eq!(
            classify("query { f(arg: \"\"\"block } { string\"\"\") { x } }"),
            GraphqlOpKind::Query
        );
    }

    // ── The fail-closed arms ─────────────────────────────────────────────

    #[test]
    fn mutations_classify_as_mutation() {
        assert_eq!(
            classify("mutation { createPullRequest(input: {}) { pullRequest { number } } }"),
            GraphqlOpKind::Mutation
        );
        // A mutation hidden behind a query in the same document.
        assert_eq!(
            classify("query Q { viewer { login } } mutation M { deleteRef(input: {}) { ok } }"),
            GraphqlOpKind::Mutation
        );
        assert_eq!(
            classify("subscription { events { id } }"),
            GraphqlOpKind::Mutation
        );
    }

    #[test]
    fn doubtful_inputs_classify_as_mutation() {
        // No body at all / empty.
        assert_eq!(classify_graphql_body(None), GraphqlOpKind::Mutation);
        assert_eq!(classify_graphql_body(Some(b"")), GraphqlOpKind::Mutation);
        // Not JSON (covers a 16KB-truncated buffer).
        assert_eq!(
            classify_graphql_body(Some(b"{\"query\": \"query { viewer ")),
            GraphqlOpKind::Mutation
        );
        // JSON without a string `query` field.
        assert_eq!(classify_graphql_body(Some(b"{}")), GraphqlOpKind::Mutation);
        assert_eq!(
            classify_graphql_body(Some(b"{\"query\": 42}")),
            GraphqlOpKind::Mutation
        );
        assert_eq!(
            classify_graphql_body(Some(b"[1,2]")),
            GraphqlOpKind::Mutation
        );
        // Unbalanced / unterminated documents.
        assert_eq!(
            classify("query { viewer { login }"),
            GraphqlOpKind::Mutation
        );
        assert_eq!(classify("query { viewer } }"), GraphqlOpKind::Mutation);
        assert_eq!(
            classify("query { f(arg: \"unterminated) { x } }"),
            GraphqlOpKind::Mutation
        );
        // Fragments only - no executable operation.
        assert_eq!(
            classify("fragment F on User { login }"),
            GraphqlOpKind::Mutation
        );
        // Dangling header without a selection set.
        assert_eq!(classify("query Named"), GraphqlOpKind::Mutation);
        // Empty / junk documents.
        assert_eq!(classify(""), GraphqlOpKind::Mutation);
        assert_eq!(classify("!!!"), GraphqlOpKind::Mutation);
    }

    #[test]
    fn duplicate_or_escaped_query_keys_fail_closed() {
        // Duplicate `query` keys: serde_json reads last-wins, an upstream
        // might read first-wins - refuse to classify at all.
        assert_eq!(
            classify_graphql_body(Some(
                br#"{"query": "mutation { x }", "query": "query { y }"}"#
            )),
            GraphqlOpKind::Mutation
        );
        // An escape inside a top-level key could alias `query` post-decode.
        assert_eq!(
            classify_graphql_body(Some(br#"{"quer\u0079": "query { y }"}"#)),
            GraphqlOpKind::Mutation
        );
        // Nested `query` keys and `query`-valued strings do NOT trip the
        // guard - one literal top-level key stays classifiable.
        assert_eq!(
            classify_graphql_body(Some(
                br#"{"variables": {"query": "mutation { x }"}, "query": "query { y }"}"#
            )),
            GraphqlOpKind::Query
        );
        assert_eq!(
            classify_graphql_body(Some(
                br#"{"operationName": "query", "query": "query { y }"}"#
            )),
            GraphqlOpKind::Query
        );
    }
}
