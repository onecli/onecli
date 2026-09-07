//! App-target expansion, driven by the shared #626 catalog JSON.
//!
//! The backfill compiles a byte-faithful app-permission group into an `app`
//! target (`provider` + `tools`); the gateway re-expands it here into the same
//! `(host, path, method)` fan-out and matches it through the gateway's own
//! `host_matches` + `matches_request` — so an app-target rule enforces identically
//! to the network rows it was compiled from (§7.7).
//!
//! Single source of truth: the JSON is DERIVED from and drift-checked against the
//! TypeScript catalog (`packages/api/src/apps/app-permissions/catalog-json.ts`),
//! so the TS translator and this Rust expansion can never disagree. The two files
//! is read at compile time (like `corpus_test`'s corpus) and covers the shared
//! and cloud providers in one file.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

use common::util::host_matches;
use policy::{matches_request, ConditionBody, PolicyAction, PolicyRule};

use super::graphql::classify_graphql_body;

/// One tool's endpoint fan-out, mirroring `CatalogTool` in `catalog-json.ts`.
/// `methods` empty = any method (the `[tool.method ?? null]` fallback in
/// `allRuleVariants`). The JSON keys are camelCase (`hostPattern`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogTool {
    /// Every host this tool answers on (`hostPattern` + `hostAliasPatterns` in
    /// the TS catalog). Matching is ANY-of; the list is never empty, so a tool
    /// can never degrade into a host-less rule.
    hosts: Vec<String>,
    paths: Vec<String>,
    methods: Vec<String>,
    /// GraphQL operation discrimination (`AppTool.graphqlOps`): present only
    /// on tools sharing a `POST /graphql` endpoint. When set, the tool
    /// matches only when the FAIL-CLOSED body classifier (`graphql.rs`)
    /// agrees - `"query"` requires a provably pure query document; every
    /// doubtful body classifies as `"mutation"`.
    graphql_ops: Option<String>,
}

type Catalog = HashMap<String, HashMap<String, CatalogTool>>;

// Compile-time embed of the local generated catalog (this file's dir). The JSON
// is the gateway's own build artifact — derived from the shared TS catalog by
// `pnpm generate:catalog` and drift-checked (`ee/apps/catalog-json.test.ts`).
// One generated catalog for every edition (shared + cloud providers), derived
// from the TS registry by `cloud-scripts/generate-catalog.ts` and drift-checked
// by `catalog-json.test.ts`.
const CATALOG_JSON: &str = include_str!("catalog.generated.json");

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| serde_json::from_str(CATALOG_JSON).expect("parse catalog JSON"))
}

/// Whether ALL of a provider's catalog tools share a single `host_pattern`. For
/// such an app every host it injects on is the same API served under a twin host
/// (a regional/apex mirror), so a tool-scoped rule may safely fold the app's full
/// injection surface. For a MULTI-host-family app (AWS's per-service subdomains),
/// the host discriminates which tool, so folding would let a tool rule bleed
/// across sibling services — those are excluded.
fn single_host_family(provider_tools: &HashMap<String, CatalogTool>) -> bool {
    /// Set equality over two host lists. Order-insensitive without sorting (so
    /// this stays allocation-free on the request path): equal lengths plus
    /// one-way containment IS set equality, because a tool's host list is
    /// duplicate-free — pinned at authoring time by `catalog-json.test.ts`
    /// ("no tool declares a duplicate host pattern"). Lists are ≤ a handful of
    /// entries, so the quadratic scan is cheaper than allocating.
    fn same_host_set(a: &[String], b: &[String]) -> bool {
        a.len() == b.len() && a.iter().all(|host| b.contains(host))
    }

    let mut tools = provider_tools.values();
    match tools.next() {
        // Every tool must answer on the SAME host set. A tool carrying any
        // host its siblings do not is a distinct family, so the app keeps the
        // multi-family treatment (no folding of the injection zone) — the
        // conservative arm.
        Some(first) => tools.all(|tool| same_host_set(&first.hosts, &tool.hosts)),
        None => false,
    }
}

/// Build a throwaway `policy::PolicyRule` so an app tool's path×method variant
/// routes through the gateway's exact `matches_request`. Conditions ride from
/// the owning rule, and `action` carries the owning rule's POLARITY (#999):
/// it decides how an unknown body-condition result on a truncated body
/// resolves — restrictive rules match (fail closed), permissive rules don't.
fn variant_rule(
    path_pattern: &str,
    method: Option<String>,
    conditions: &Option<serde_json::Value>,
    action: PolicyAction,
) -> PolicyRule {
    PolicyRule {
        name: String::new(),
        path_pattern: path_pattern.to_string(),
        method,
        action,
        conditions_raw: conditions.clone(),
    }
}

/// Could a tool-scoped app target's HOST surface cover this request? The
/// body-buffer pre-check (#999): a tool reaches a request through its own
/// catalog host or through the app's injection mirror — the same host
/// disjunction `app_target_matches` uses, with path/method/conditions
/// deliberately ignored (the pre-check must be a superset of real matching:
/// over-buffering costs memory, under-buffering would decide a body rule
/// bodiless). Unknown provider or empty tools → false (a whole-app target is
/// host-only and never consults the body).
pub(super) fn app_target_could_match_host(
    provider: &str,
    tools: &[String],
    request_host: &str,
    request_path: &str,
) -> bool {
    let Some(provider_tools) = catalog().get(provider) else {
        return false;
    };
    if tools.is_empty() {
        return false;
    }
    let host_via_mirror = apps::provider_matches_path_scoped(provider, request_host, request_path)
        || (single_host_family(provider_tools)
            && apps::provider_matches_host_and_path(provider, request_host, request_path));
    host_via_mirror
        || tools.iter().any(|tool_id| {
            provider_tools
                .get(tool_id)
                .is_some_and(|tool| tool.hosts.iter().any(|h| host_matches(request_host, h)))
        })
}

/// Does an app target name a `graphqlOps`-discriminated tool that could match
/// this request's host? Drives the body-buffer decision: without the buffered
/// body the classifier fail-closes every request to "mutation", which would
/// break allowed queries — but only requests the tool's host surface can
/// reach need the body at all (#999). A whole-app target (empty tools)
/// matches host-only and never consults the classifier, so it needs no body.
pub(super) fn any_graphql_discriminated_for_host(
    provider: &str,
    tools: &[String],
    request_host: &str,
    request_path: &str,
) -> bool {
    let Some(provider_tools) = catalog().get(provider) else {
        return false;
    };
    let any_graphql = tools.iter().any(|tool_id| {
        provider_tools
            .get(tool_id)
            .is_some_and(|tool| tool.graphql_ops.is_some())
    });
    any_graphql && app_target_could_match_host(provider, tools, request_host, request_path)
}

/// Does the request hit the app target? Mirrors `appTargetMatches` (byte-lockstep
/// with the OSS core's `app_target_matches`). The host decision defers to the
/// **injection registry** (`apps`) so a rule governs exactly the hosts the
/// app's credential is injected on — closing the class where a request is
/// credentialed but no rule matches it (e.g. Gmail's legacy
/// `www.googleapis.com/gmail/` mirror of `gmail.googleapis.com`). It is a UNION
/// with the catalog's own tool host, so it only ever widens matching (never drops
/// an existing match) and still covers a catalog provider absent from the
/// injection registry. An unknown provider or tool id matches nothing (fail-safe).
///
/// - **Whole-app** (empty tools): matches any host the app injects on — the app's
///   FULL injection surface (host-only, any path/method, conditions ignored — the
///   `Target::Secret` mirror; the dialog's "All connections" shape and an
///   empty-tools `connection` target decode here) — including a broad credential
///   zone like AWS's `*.amazonaws.com`.
/// - **Tool-scoped**: a tool matches on its own catalog host OR an injection
///   **mirror** of the app — a path-scoped mirror, or (for a single-host-family
///   app, all tools on one host) any host the app injects on, its regional/apex
///   twins like datadog `.datadoghq.eu` / sentry apex — then its path×method
///   (subject to conditions). It does NOT fold a MULTI-host injection zone (AWS's
///   per-service `*.amazonaws.com`), so a tool rule can't bleed across sibling
///   services. A truly distinct endpoint host is its own catalog tool; whole-app
///   rules also cover it.
#[allow(clippy::too_many_arguments)]
pub(super) fn app_target_matches(
    provider: &str,
    tools: &[String],
    request_host: &str,
    request_method: &str,
    request_path: &str,
    body: ConditionBody<'_>,
    conditions: &Option<serde_json::Value>,
    polarity: PolicyAction,
) -> bool {
    let Some(provider_tools) = catalog().get(provider) else {
        return false;
    };
    if tools.is_empty() {
        return provider_tools
            .values()
            .any(|tool| tool.hosts.iter().any(|h| host_matches(request_host, h)))
            || apps::provider_matches_host_and_path(provider, request_host, request_path);
    }
    // The host is the app's per-tool catalog host OR an injection MIRROR of the
    // app (tool-independent → computed once): a path-scoped mirror (Gmail's
    // `www.googleapis.com/gmail/`), or — for a single-host-family app (all its
    // tools on one host, so its other injection hosts are regional/apex twins of
    // the same API, e.g. datadog `.datadoghq.eu`, sentry apex) — any host the app
    // injects on. A multi-host-family app (AWS's per-service `ec2.*`/`s3.*`/…) is
    // excluded, so a tool rule can never bleed across sibling services on a
    // shared credential zone.
    let host_via_mirror = apps::provider_matches_path_scoped(provider, request_host, request_path)
        || (single_host_family(provider_tools)
            && apps::provider_matches_host_and_path(provider, request_host, request_path));
    tools.iter().any(|tool_id| {
        let Some(tool) = provider_tools.get(tool_id) else {
            return false;
        };
        let host_ok = tool.hosts.iter().any(|h| host_matches(request_host, h));
        if !host_ok && !host_via_mirror {
            return false;
        }
        // GraphQL-discriminated tool: the body's classified operation kind
        // must agree. Classification is fail-closed (no/unparsable body →
        // mutation), and a TRUNCATED body is forced to mutation explicitly
        // (#999) — never classified from the prefix, even when the prefix
        // happens to parse — so a "query" tool can never admit an operation
        // whose tail was unseen and a "mutation" tool always covers the
        // doubtful cases. A request URL carrying any query string also
        // classifies as mutation: some GraphQL servers honor `?query=` URL
        // operations (the GraphQL-over-HTTP GET convention), and the path
        // matcher strips query strings - so a URL param could smuggle an
        // operation the body classifier never saw.
        if let Some(ops) = &tool.graphql_ops {
            let classified = if request_path.contains('?') || body.is_truncated() {
                super::graphql::GraphqlOpKind::Mutation
            } else {
                classify_graphql_body(body.bytes())
            };
            if classified.as_catalog_str() != ops {
                return false;
            }
        }
        // `allRuleVariants`: paths × methods, where an empty method list means
        // "any method" (`None`).
        let methods: Vec<Option<&str>> = if tool.methods.is_empty() {
            vec![None]
        } else {
            tool.methods.iter().map(|m| Some(m.as_str())).collect()
        };
        tool.paths.iter().any(|path| {
            methods.iter().any(|method| {
                let rule = variant_rule(
                    path,
                    method.map(str::to_string),
                    conditions,
                    polarity.clone(),
                );
                matches_request(&rule, request_method, request_path, body)
            })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── AWS endpoint coverage: the Rust half of the TS
    // `aws-endpoint-coverage.test.ts` table. Both ports read the SAME generated
    // catalog and must agree, so the same triples are asserted on both sides —
    // a divergence here means the gateway enforces something other than what
    // the API believes it granted.

    #[test]
    fn single_host_family_is_order_insensitive_and_stays_conservative() {
        // `same_host_set` relies on duplicate-free host lists (pinned by
        // `catalog-json.test.ts`). These pin the two properties the fold
        // decision rests on, since a false-positive here would WIDEN every
        // tool rule of the provider into its whole injection zone.
        let tool = |hosts: &[&str]| CatalogTool {
            hosts: hosts.iter().map(|h| (*h).to_string()).collect(),
            paths: vec!["/*".to_string()],
            methods: vec![],
            graphql_ops: None,
        };
        let map = |pairs: &[(&str, CatalogTool)]| -> HashMap<String, CatalogTool> {
            pairs
                .iter()
                .map(|(k, v)| {
                    (
                        (*k).to_string(),
                        CatalogTool {
                            hosts: v.hosts.clone(),
                            paths: v.paths.clone(),
                            methods: v.methods.clone(),
                            graphql_ops: v.graphql_ops.clone(),
                        },
                    )
                })
                .collect()
        };

        // Same set, different order → one family (HashMap iteration order is
        // arbitrary, so this must not depend on it).
        assert!(single_host_family(&map(&[
            ("a", tool(&["x.example.com", "y.example.com"])),
            ("b", tool(&["y.example.com", "x.example.com"])),
        ])));
        // A tool with an extra host is a DISTINCT family → no folding.
        assert!(!single_host_family(&map(&[
            ("a", tool(&["x.example.com"])),
            ("b", tool(&["x.example.com", "y.example.com"])),
        ])));
        // Disjoint sets of equal length → distinct families.
        assert!(!single_host_family(&map(&[
            ("a", tool(&["x.example.com"])),
            ("b", tool(&["y.example.com"])),
        ])));
        // The real AWS catalog must stay MULTI-family, or a tool rule would
        // fold into the whole `*.amazonaws.com` credential zone.
        for provider in ["aws", "aws-role"] {
            assert!(
                !single_host_family(catalog().get(provider).expect("provider in catalog")),
                "{provider} must remain multi-host-family"
            );
        }
    }

    #[test]
    fn aws_tool_rules_cover_real_endpoint_shapes() {
        for provider in ["aws", "aws-role"] {
            // S3 path-style: regional, global.
            assert!(matches(
                provider,
                &["s3_list_buckets"],
                "s3.us-east-1.amazonaws.com",
                "GET",
                "/"
            ));
            assert!(matches(
                provider,
                &["s3_list_buckets"],
                "s3.amazonaws.com",
                "GET",
                "/"
            ));
            // STS: SDK POST, Query-over-GET, and the global endpoint.
            assert!(matches(
                provider,
                &["sts_access"],
                "sts.us-east-1.amazonaws.com",
                "POST",
                "/"
            ));
            assert!(matches(
                provider,
                &["sts_access"],
                "sts.us-east-1.amazonaws.com",
                "GET",
                "/?Action=GetCallerIdentity&Version=2011-06-15"
            ));
            assert!(matches(
                provider,
                &["sts_access"],
                "sts.amazonaws.com",
                "GET",
                "/?Action=GetCallerIdentity&Version=2011-06-15"
            ));
            // IAM is global-only, and answers both verbs.
            assert!(matches(
                provider,
                &["iam_access"],
                "iam.amazonaws.com",
                "POST",
                "/"
            ));
            assert!(matches(
                provider,
                &["iam_access"],
                "iam.amazonaws.com",
                "GET",
                "/?Action=ListRoles"
            ));
            // SES v2 serves its whole API under /v2/email/.
            assert!(matches(
                provider,
                &["ses_send"],
                "email.us-east-1.amazonaws.com",
                "GET",
                "/v2/email/identities"
            ));
        }
    }

    #[test]
    fn aws_tool_rules_never_reach_sibling_services() {
        for provider in ["aws", "aws-role"] {
            // s3tables / s3-control are SEPARATE services with their own IAM
            // actions — exactly what a loose `s3*.amazonaws.com` would swallow.
            for host in [
                "s3tables.us-east-1.amazonaws.com",
                "s3-control.us-east-1.amazonaws.com",
                "s3express-control.us-east-1.amazonaws.com",
                "ec2.us-east-1.amazonaws.com",
                // A look-alike registrable domain must never satisfy a suffix.
                "s3.us-east-1.amazonaws.com.evil.test",
            ] {
                assert!(
                    !matches(provider, &["s3_read_objects"], host, "GET", "/key"),
                    "{provider}: s3_read_objects must not match {host}"
                );
            }
            assert!(!matches(
                provider,
                &["sts_access"],
                "iam.amazonaws.com",
                "POST",
                "/"
            ));
            assert!(!matches(
                provider,
                &["iam_access"],
                "sts.us-east-1.amazonaws.com",
                "POST",
                "/"
            ));
        }
    }

    #[test]
    fn aws_tool_rules_cover_multi_wildcard_endpoint_shapes() {
        // The shapes #988 could not express and #989 closed: virtual-hosted S3
        // and DynamoDB's account-specific endpoint, both needing TWO blanks.
        for provider in ["aws", "aws-role"] {
            assert!(matches(
                provider,
                &["s3_read_objects"],
                "my-bucket.s3.us-east-1.amazonaws.com",
                "GET",
                "/key"
            ));
            assert!(matches(
                provider,
                &["dynamodb_access"],
                "123456789012.ddb.us-east-1.amazonaws.com",
                "POST",
                "/"
            ));
            // Each `*` is exactly ONE label, so a deeper host still fails and
            // the pattern cannot creep down the tree.
            assert!(!matches(
                provider,
                &["s3_read_objects"],
                "a.b.s3.us-east-1.amazonaws.com",
                "GET",
                "/key"
            ));
            // …and the sibling services stay out of reach.
            assert!(!matches(
                provider,
                &["s3_read_objects"],
                "s3tables.us-east-1.amazonaws.com",
                "GET",
                "/key"
            ));
        }
    }

    // The app-target enforcement path — the primary path for app-permission rules,
    // yet NEVER exercised by the step-4 shadow/corpus (which emit only network
    // targets). These pin the equivalence the cutover's behavior-preservation
    // relies on: an app target matches EXACTLY the (host, path, method) fan-out the
    // shared catalog defines for its tools — no more, no less. Anchored on stable
    // catalog entries (github issue/PR create = POST api.github.com /repos/*/*/…).

    fn matches(provider: &str, tools: &[&str], host: &str, method: &str, path: &str) -> bool {
        let tools: Vec<String> = tools.iter().map(|s| s.to_string()).collect();
        app_target_matches(
            provider,
            &tools,
            host,
            method,
            path,
            ConditionBody::None,
            &None,
            PolicyAction::Allow,
        )
    }

    fn matches_with_body(
        provider: &str,
        tools: &[&str],
        host: &str,
        method: &str,
        path: &str,
        body: &str,
    ) -> bool {
        let tools: Vec<String> = tools.iter().map(|s| s.to_string()).collect();
        app_target_matches(
            provider,
            &tools,
            host,
            method,
            path,
            ConditionBody::Full(body.as_bytes()),
            &None,
            PolicyAction::Allow,
        )
    }

    fn graphql_envelope(document: &str) -> String {
        serde_json::json!({ "query": document }).to_string()
    }

    // ── GraphQL operation discrimination (the create-PR-via-GraphQL bypass) ──

    #[test]
    fn graphql_query_tool_admits_only_provably_pure_queries() {
        let query = graphql_envelope("query { viewer { login } }");
        let mutation = graphql_envelope(
            "mutation { createPullRequest(input: {}) { pullRequest { number } } }",
        );
        // The query tool matches a pure query…
        assert!(matches_with_body(
            "github",
            &["graphql_query"],
            "api.github.com",
            "POST",
            "/graphql",
            &query
        ));
        // …but NEVER a mutation - the bypass this discrimination closes: with
        // graphql_query allowed and graphql_mutation blocked, a
        // `mutation { createPullRequest }` must not ride the query allow.
        assert!(!matches_with_body(
            "github",
            &["graphql_query"],
            "api.github.com",
            "POST",
            "/graphql",
            &mutation
        ));
        // The mutation tool is the mirror image.
        assert!(matches_with_body(
            "github",
            &["graphql_mutation"],
            "api.github.com",
            "POST",
            "/graphql",
            &mutation
        ));
        assert!(!matches_with_body(
            "github",
            &["graphql_mutation"],
            "api.github.com",
            "POST",
            "/graphql",
            &query
        ));
    }

    #[test]
    fn graphql_doubtful_bodies_fail_closed_to_the_mutation_tool() {
        // No body at all: the query tool must NOT match (fail-closed), the
        // mutation tool must (so a block on it still fires).
        assert!(!matches(
            "github",
            &["graphql_query"],
            "api.github.com",
            "POST",
            "/graphql"
        ));
        assert!(matches(
            "github",
            &["graphql_mutation"],
            "api.github.com",
            "POST",
            "/graphql"
        ));
        // A truncated/unparsable body (the 16KB buffer limit) fails closed too.
        assert!(!matches_with_body(
            "github",
            &["graphql_query"],
            "api.github.com",
            "POST",
            "/graphql",
            "{\"query\": \"query { viewer "
        ));
        // A mixed document (query + mutation) is a mutation.
        let mixed = graphql_envelope("query Q { viewer { login } } mutation M { x { y } }");
        assert!(!matches_with_body(
            "github",
            &["graphql_query"],
            "api.github.com",
            "POST",
            "/graphql",
            &mixed
        ));
        assert!(matches_with_body(
            "github",
            &["graphql_mutation"],
            "api.github.com",
            "POST",
            "/graphql",
            &mixed
        ));
    }

    #[test]
    fn graphql_discrimination_covers_the_all_graphql_providers() {
        // Linear: every tool shares POST /graphql; read tools are query-tagged,
        // write tools mutation-tagged.
        let query = graphql_envelope("query { issues { nodes { id } } }");
        let mutation = graphql_envelope("mutation { issueCreate(input: {}) { success } }");
        assert!(matches_with_body(
            "linear",
            &["list_issues"],
            "api.linear.app",
            "POST",
            "/graphql",
            &query
        ));
        assert!(!matches_with_body(
            "linear",
            &["list_issues"],
            "api.linear.app",
            "POST",
            "/graphql",
            &mutation
        ));
        assert!(matches_with_body(
            "linear",
            &["create_issue"],
            "api.linear.app",
            "POST",
            "/graphql",
            &mutation
        ));
        // Non-GraphQL tools are untouched by the discrimination: a REST tool
        // matches with or without a body.
        assert!(matches_with_body(
            "github",
            &["create_issue"],
            "api.github.com",
            "POST",
            "/repos/o/r/issues",
            "{\"title\": \"t\"}"
        ));
    }

    #[test]
    fn whole_app_target_ignores_graphql_discrimination() {
        // The whole-app arm is host-only - a mutation body still matches it
        // (blocking the whole app blocks GraphQL too).
        let mutation = graphql_envelope("mutation { x { y } }");
        assert!(matches_with_body(
            "github",
            &[],
            "api.github.com",
            "POST",
            "/graphql",
            &mutation
        ));
    }

    #[test]
    fn app_target_matches_its_tool_endpoint_and_nothing_else() {
        // create_issue = POST api.github.com /repos/*/*/issues
        assert!(matches(
            "github",
            &["create_issue"],
            "api.github.com",
            "POST",
            "/repos/o/r/issues"
        ));
        // Wrong host, method, or path → no match (the fan-out is exact, per variant).
        assert!(!matches(
            "github",
            &["create_issue"],
            "api.gitlab.com",
            "POST",
            "/repos/o/r/issues"
        ));
        assert!(!matches(
            "github",
            &["create_issue"],
            "api.github.com",
            "GET",
            "/repos/o/r/issues"
        ));
        assert!(!matches(
            "github",
            &["create_issue"],
            "api.github.com",
            "POST",
            "/repos/o/r/pulls"
        ));
    }

    #[test]
    fn app_target_unions_its_tools_and_fails_safe_on_unknowns() {
        // A multi-tool target matches any of its tools' endpoints.
        assert!(matches(
            "github",
            &["create_issue", "create_pull"],
            "api.github.com",
            "POST",
            "/repos/o/r/pulls"
        ));
        // An unknown provider or an unknown tool id matches NOTHING (fail-safe —
        // a stale rule can't widen to "any").
        assert!(!matches(
            "no_such_provider",
            &["create_issue"],
            "api.github.com",
            "POST",
            "/repos/o/r/issues"
        ));
        assert!(!matches(
            "github",
            &["no_such_tool"],
            "api.github.com",
            "POST",
            "/repos/o/r/issues"
        ));
    }

    #[test]
    fn google_calendar_get_calendar_covers_the_agent_probe_url() {
        // The URL most calendar agents open with (calendars.get on the primary
        // calendar). get_calendar = GET www.googleapis.com /calendar/v3/calendars/*.
        let probe = "/calendar/v3/calendars/primary";
        assert!(matches(
            "google-calendar",
            &["get_calendar"],
            "www.googleapis.com",
            "GET",
            probe
        ));
        // The pre-existing GRANULAR read tools do NOT cover the probe — the gap
        // that stalled tool-scoped agents on their first calendar call before
        // get_calendar existed (the read_all wildcard always covered it).
        assert!(!matches(
            "google-calendar",
            &["list_events", "get_event", "list_calendars"],
            "www.googleapis.com",
            "GET",
            probe
        ));
        // Path fencing: get_calendar is scoped to the calendars/ subtree — it
        // must never widen to the whole /calendar/v3/* read surface (read_all).
        assert!(!matches(
            "google-calendar",
            &["get_calendar"],
            "www.googleapis.com",
            "GET",
            "/calendar/v3/users/me/calendarList"
        ));
        // Method fencing: the tool is read-only.
        assert!(!matches(
            "google-calendar",
            &["get_calendar"],
            "www.googleapis.com",
            "POST",
            probe
        ));
    }

    #[test]
    fn empty_tool_set_matches_the_whole_app_host_only() {
        // An EMPTY tool set is the WHOLE app (the dialog's "All connections" and
        // an empty-tools `connection` target): host-only against every catalog
        // tool host of the provider — any path, any method (the `Target::Secret`
        // mirror). github's catalog hosts include api.github.com.
        assert!(matches(
            "github",
            &[],
            "api.github.com",
            "POST",
            "/repos/o/r/issues"
        ));
        assert!(matches(
            "github",
            &[],
            "api.github.com",
            "GET",
            "/anything/at/all"
        ));
        // gmail (the user-reported shape): gmail.googleapis.com, any endpoint.
        assert!(matches(
            "gmail",
            &[],
            "gmail.googleapis.com",
            "GET",
            "/gmail/v1/x"
        ));
        // A host outside the provider's catalog set never matches…
        assert!(!matches("github", &[], "api.gitlab.com", "GET", "/repos"));
        assert!(!matches(
            "gmail",
            &[],
            "api.github.com",
            "GET",
            "/gmail/v1/x"
        ));
        // …and an unknown/catalog-less provider still matches nothing (fail-safe:
        // the permit surface can never exceed the catalog).
        assert!(!matches(
            "no_such_provider",
            &[],
            "api.github.com",
            "GET",
            "/x"
        ));
        // WILDCARD catalog hosts route through the same host_matches: aws's
        // s3.*.amazonaws.com covers any region label, never a different service
        // host shape.
        assert!(matches(
            "aws",
            &[],
            "s3.eu-west-1.amazonaws.com",
            "GET",
            "/bucket"
        ));
        assert!(!matches(
            "aws",
            &[],
            "s3.amazonaws.com.evil.com",
            "GET",
            "/x"
        ));
    }

    #[test]
    fn empty_tool_set_ignores_conditions_and_body() {
        // The whole-app arm is host-only — rule conditions (and the body) never
        // gate it, exactly like `Target::Secret`. A body-contains condition that
        // does NOT hold must not stop the match.
        let conditions = Some(serde_json::json!([
            { "target": "body", "operator": "contains", "value": "absent-token" }
        ]));
        assert!(app_target_matches(
            "gmail",
            &[],
            "gmail.googleapis.com",
            "POST",
            "/gmail/v1/send",
            ConditionBody::Full(b"hello world"),
            &conditions,
            PolicyAction::Allow,
        ));
    }

    // ── Injection-surface coverage (credential-injection bypass fix) ──────────
    // Same host-decision-defers-to-injection-registry behavior as the OSS core;
    // pinned here so the cloud lane proves it, incl. an EE-only provider.

    #[test]
    fn gmail_rule_covers_the_legacy_www_endpoint() {
        // Whole-app AND tool-scoped Gmail rules now match the legacy
        // www.googleapis.com/gmail/* host (creds are injected there); the
        // primary host is unchanged; a non-Gmail path on the shared host is not.
        let path = "/gmail/v1/users/me/drafts";
        assert!(matches("gmail", &[], "www.googleapis.com", "POST", path));
        assert!(matches(
            "gmail",
            &["create_draft"],
            "www.googleapis.com",
            "POST",
            path
        ));
        assert!(matches(
            "gmail",
            &["create_draft"],
            "gmail.googleapis.com",
            "POST",
            path
        ));
        assert!(!matches(
            "gmail",
            &[],
            "www.googleapis.com",
            "GET",
            "/calendar/v3/x"
        ));
    }

    #[test]
    fn stripe_rules_cover_the_files_upload_host() {
        // Stripe injects on api.stripe.com AND files.stripe.com (the Files API's
        // separate upload host), but every catalog tool lists api.stripe.com
        // only. Stripe is therefore a SINGLE-host-family app, so both whole-app
        // and tool-scoped rules must still govern files.stripe.com — otherwise a
        // request would carry the injected key while no rule matched it, the
        // exact credentialed-but-ungoverned class this deferral closes.
        assert!(matches(
            "stripe",
            &[],
            "files.stripe.com",
            "POST",
            "/v1/files"
        ));
        assert!(matches(
            "stripe",
            &["write_all"],
            "files.stripe.com",
            "POST",
            "/v1/files"
        ));
        assert!(matches(
            "stripe",
            &[],
            "api.stripe.com",
            "GET",
            "/v1/charges"
        ));
    }

    #[test]
    fn stripe_write_gate_covers_both_api_namespaces() {
        // The "require approval for every write" toggle compiles to the
        // write_all wildcard. Stripe serves TWO namespaces and /v2 already
        // carries money-moving writes, so a /v1-only gate would silently let
        // every v2 write through. Assert through the REAL matcher, not the
        // authored patterns.
        for (method, path) in [
            ("POST", "/v1/refunds"),
            ("POST", "/v1/payouts"),
            ("DELETE", "/v1/subscriptions/sub_123"),
            ("POST", "/v2/money_management/payout_methods"),
            ("POST", "/v2/core/accounts"),
        ] {
            assert!(
                matches("stripe", &["write_all"], "api.stripe.com", method, path),
                "write gate must cover {method} {path}"
            );
        }
    }

    #[test]
    fn stripe_read_only_grant_never_authorizes_a_write() {
        // A read-scoped grant must not match a mutating request: read_all is
        // GET-only, so the money-moving calls fall through to the compiled
        // stack's terminal block (fail-closed).
        for (method, path) in [
            ("POST", "/v1/refunds"),
            ("POST", "/v1/payouts"),
            ("DELETE", "/v1/customers/cus_123"),
            ("POST", "/v2/money_management/payout_methods"),
        ] {
            assert!(
                !matches("stripe", &["read_all"], "api.stripe.com", method, path),
                "a read-only grant must NOT authorize {method} {path}"
            );
        }
        assert!(matches(
            "stripe",
            &["read_all"],
            "api.stripe.com",
            "GET",
            "/v1/charges"
        ));
    }

    #[test]
    fn stripe_rules_never_reach_a_foreign_host() {
        // A Stripe rule must not govern (or imply credentials for) hosts the
        // provider does not inject on — including Stripe's own browser-facing
        // hosts and a lookalike suffix an attacker could register.
        for host in [
            "dashboard.stripe.com",
            "checkout.stripe.com",
            "api.stripe.com.evil.example",
        ] {
            assert!(
                !matches("stripe", &[], host, "GET", "/v1/charges"),
                "whole-app rule must not reach {host}"
            );
            assert!(
                !matches("stripe", &["read_all"], host, "GET", "/v1/charges"),
                "tool rule must not reach {host}"
            );
        }
    }

    #[test]
    fn datadog_whole_app_covers_the_eu_region() {
        // EE-only provider: Datadog injects on .datadoghq.com AND .datadoghq.eu
        // but the catalog lists only *.datadoghq.com. A whole-app rule must
        // cover the EU region (broad-zone bypass closed for whole-app rules).
        assert!(matches(
            "datadog",
            &[],
            "api.datadoghq.eu",
            "GET",
            "/api/v1/x"
        ));
        assert!(matches(
            "datadog",
            &[],
            "api.datadoghq.com",
            "GET",
            "/api/v1/x"
        ));
    }

    #[test]
    fn datadog_tool_scoped_covers_the_regional_mirror() {
        // Datadog is single-host-family (all tools on `*.datadoghq.com`), so its
        // `.datadoghq.eu`/`.ddog-gov.com` injection hosts are regional twins of
        // the same API — a TOOL-scoped rule folds them (Fix B). The tool still
        // requires its own path×method, so this is the same operation, elsewhere.
        let path = "/api/v1/service_dependencies";
        assert!(matches(
            "datadog",
            &["apm_services"],
            "api.datadoghq.com",
            "GET",
            path
        ));
        assert!(matches(
            "datadog",
            &["apm_services"],
            "api.datadoghq.eu",
            "GET",
            path
        ));
        // ...but a path the tool does not serve still does not match on the twin.
        assert!(!matches(
            "datadog",
            &["apm_services"],
            "api.datadoghq.eu",
            "GET",
            "/api/v1/unrelated"
        ));
    }

    #[test]
    fn affinity_mcp_endpoint_is_its_own_tool() {
        // The MCP host is cataloged as its own tool (any method), so a tool-scoped
        // rule can govern the Affinity MCP server; the REST tools stay on api.*.
        assert!(matches(
            "affinity",
            &["mcp"],
            "mcp.affinity.co",
            "POST",
            "/"
        ));
        assert!(matches(
            "affinity",
            &["mcp"],
            "mcp.affinity.co",
            "GET",
            "/sse"
        ));
        assert!(!matches(
            "affinity",
            &["mcp"],
            "api.affinity.co",
            "GET",
            "/v2/persons"
        ));
    }

    #[test]
    fn catalog_only_provider_is_unaffected() {
        // A provider matched purely via its catalog host keeps matching exactly
        // as before — the union never narrows.
        assert!(matches(
            "github",
            &["create_issue"],
            "api.github.com",
            "POST",
            "/repos/o/r/issues"
        ));
        assert!(!matches(
            "github",
            &["create_issue"],
            "example.com",
            "POST",
            "/repos/o/r/issues"
        ));
    }

    #[test]
    fn aws_whole_app_covers_uncataloged_services_but_tool_scope_stays_precise() {
        // Whole-app AWS covers an uncataloged service; a tool-scoped AWS rule
        // does not bleed across the bare `*.amazonaws.com` zone.
        assert!(matches(
            "aws",
            &[],
            "rds.us-east-1.amazonaws.com",
            "POST",
            "/"
        ));
        assert!(!matches(
            "aws",
            &["ec2_access"],
            "rds.us-east-1.amazonaws.com",
            "POST",
            "/"
        ));
        assert!(matches(
            "aws",
            &["ec2_access"],
            "ec2.us-east-1.amazonaws.com",
            "POST",
            "/"
        ));
    }

    /// Enforcement ⊇ injection: a whole-app rule covers every host the gateway
    /// injects a credential on (base + EE providers in this lane).
    #[test]
    fn whole_app_rules_cover_the_entire_injection_surface() {
        for (provider, host, path) in apps::injection_surface_samples() {
            if catalog().get(provider).is_none() {
                continue;
            }
            assert!(
                app_target_matches(
                    provider,
                    &[],
                    &host,
                    "POST",
                    &path,
                    ConditionBody::None,
                    &None,
                    PolicyAction::Allow,
                ),
                "whole-app rule for `{provider}` must cover its injection host `{host}` (path `{path}`)"
            );
        }
    }

    // ── The buffer pre-check's SUPERSET invariant (#999) ─────────────────────
    // `app_target_could_match_host` gates whether the proxy buffers the body at
    // all; if it ever returns false where `app_target_matches` can return true,
    // a body-conditioned or graphql-discriminated rule would be decided
    // BODILESS — with the fail-closed law, that means silent mass-blocking
    // (restrictive rules) or broken allowed queries (graphql). Pin the
    // implication `app_target_matches ⟹ app_target_could_match_host` across
    // the ENTIRE catalog: for every provider × tool × declared host, a request
    // that the real matcher can match must also arm the pre-check.
    #[test]
    fn could_match_host_is_a_superset_of_real_matching_for_every_tool() {
        let mut matched_cases = 0usize;
        for (provider, tools) in catalog() {
            for (tool_id, tool) in tools {
                let tool_vec = vec![tool_id.clone()];
                for host_pattern in &tool.hosts {
                    // A concrete host matching the pattern: replace each `*`
                    // with a plausible label (region/bucket shapes for AWS).
                    let host = host_pattern.replace('*', "sample");
                    for path in &tool.paths {
                        // The matcher strips query strings; use the raw path,
                        // wildcards replaced so `matches_request` can hit.
                        let concrete_path = path.replace('*', "x");
                        let method = tool.methods.first().map(String::as_str).unwrap_or("POST");
                        // Skip graphql-discriminated tools' body coupling by
                        // matching with the kind their ops demand.
                        let body: Vec<u8> = match tool.graphql_ops.as_deref() {
                            Some("query") => br#"{"query": "query { x }"}"#.to_vec(),
                            Some(_) => br#"{"query": "mutation { x }"}"#.to_vec(),
                            None => Vec::new(),
                        };
                        let matched = app_target_matches(
                            provider,
                            &tool_vec,
                            &host,
                            method,
                            &concrete_path,
                            ConditionBody::Full(&body),
                            &None,
                            PolicyAction::Allow,
                        );
                        if matched {
                            matched_cases += 1;
                            assert!(
                                app_target_could_match_host(
                                    provider,
                                    &tool_vec,
                                    &host,
                                    &concrete_path
                                ),
                                "pre-check must arm wherever matching is possible: \
                                 {provider}/{tool_id} on {host} {concrete_path}"
                            );
                        }
                    }
                }
            }
        }
        // Vacuity guard: the implication is only evidence if its antecedent
        // actually fires. The catalog has hundreds of tool endpoints; if the
        // synthetic host/path construction ever stops producing real matches
        // (e.g. a catalog shape change), fail loudly instead of passing empty.
        assert!(
            matched_cases >= 100,
            "superset property exercised only {matched_cases} matched cases — \
             the antecedent went vacuous, fix the sample construction"
        );
    }
}
