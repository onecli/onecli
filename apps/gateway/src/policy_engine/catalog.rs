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

use crate::connect::host_matches;
use crate::policy::{matches_request, PolicyAction, PolicyRule};

/// One tool's endpoint fan-out, mirroring `CatalogTool` in `catalog-json.ts`.
/// `methods` empty = any method (the `[tool.method ?? null]` fallback in
/// `allRuleVariants`). The JSON keys are camelCase (`hostPattern`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogTool {
    host_pattern: String,
    paths: Vec<String>,
    methods: Vec<String>,
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
    let mut hosts = provider_tools.values().map(|t| t.host_pattern.as_str());
    match hosts.next() {
        Some(first) => hosts.all(|h| h == first),
        None => false,
    }
}

/// Build a throwaway `policy::PolicyRule` so an app tool's path×method variant
/// routes through the gateway's exact `matches_request` (the action is
/// irrelevant to matching). Conditions ride from the owning rule.
fn variant_rule(
    path_pattern: &str,
    method: Option<String>,
    conditions: &Option<serde_json::Value>,
) -> PolicyRule {
    PolicyRule {
        name: String::new(),
        path_pattern: path_pattern.to_string(),
        method,
        action: PolicyAction::Allow,
        conditions_raw: conditions.clone(),
    }
}

/// Does the request hit the app target? Mirrors `appTargetMatches` (byte-lockstep
/// with the OSS core's `app_target_matches`). The host decision defers to the
/// **injection registry** (`crate::apps`) so a rule governs exactly the hosts the
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
    body: Option<&[u8]>,
    conditions: &Option<serde_json::Value>,
) -> bool {
    let Some(provider_tools) = catalog().get(provider) else {
        return false;
    };
    if tools.is_empty() {
        return provider_tools
            .values()
            .any(|tool| host_matches(request_host, &tool.host_pattern))
            || crate::apps::provider_matches_host_and_path(provider, request_host, request_path);
    }
    // The host is the app's per-tool catalog host OR an injection MIRROR of the
    // app (tool-independent → computed once): a path-scoped mirror (Gmail's
    // `www.googleapis.com/gmail/`), or — for a single-host-family app (all its
    // tools on one host, so its other injection hosts are regional/apex twins of
    // the same API, e.g. datadog `.datadoghq.eu`, sentry apex) — any host the app
    // injects on. A multi-host-family app (AWS's per-service `ec2.*`/`s3.*`/…) is
    // excluded, so a tool rule can never bleed across sibling services on a
    // shared credential zone.
    let host_via_mirror =
        crate::apps::provider_matches_path_scoped(provider, request_host, request_path)
            || (single_host_family(provider_tools)
                && crate::apps::provider_matches_host_and_path(
                    provider,
                    request_host,
                    request_path,
                ));
    tools.iter().any(|tool_id| {
        let Some(tool) = provider_tools.get(tool_id) else {
            return false;
        };
        if !host_matches(request_host, &tool.host_pattern) && !host_via_mirror {
            return false;
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
                let rule = variant_rule(path, method.map(str::to_string), conditions);
                matches_request(&rule, request_method, request_path, body)
            })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The app-target enforcement path — the primary path for app-permission rules,
    // yet NEVER exercised by the step-4 shadow/corpus (which emit only network
    // targets). These pin the equivalence the cutover's behavior-preservation
    // relies on: an app target matches EXACTLY the (host, path, method) fan-out the
    // shared catalog defines for its tools — no more, no less. Anchored on stable
    // catalog entries (github issue/PR create = POST api.github.com /repos/*/*/…).

    fn matches(provider: &str, tools: &[&str], host: &str, method: &str, path: &str) -> bool {
        let tools: Vec<String> = tools.iter().map(|s| s.to_string()).collect();
        app_target_matches(provider, &tools, host, method, path, None, &None)
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
            Some(b"hello world"),
            &conditions,
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
        for (provider, host, path) in crate::apps::injection_surface_samples() {
            if catalog().get(provider).is_none() {
                continue;
            }
            assert!(
                app_target_matches(provider, &[], &host, "POST", &path, None, &None),
                "whole-app rule for `{provider}` must cover its injection host `{host}` (path `{path}`)"
            );
        }
    }
}
