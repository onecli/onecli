//! App-target expansion over the SHARED base catalog. An `app` target names a
//! provider (+ optional tool ids); this module expands it to the same
//! `(host, path, method)` endpoint fan-out the catalog defines and matches it
//! through the gateway's own `host_matches` + `matches_request`, so an
//! app-target rule enforces exactly like the network rows it stands for.
//!
//! The JSON is the gateway's build artifact, derived from the shared TS catalog
//! (`packages/api/src/apps/app-permissions/catalog-json.ts`) by
//! `pnpm generate:catalog` and drift-checked against it. OSS embeds the BASE
//! catalog only — EE-only providers are simply absent, so a rule naming one
//! matches nothing (fail-closed; those apps cannot connect here either).

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::connect::host_matches;
use crate::policy::{matches_request, PolicyAction, PolicyRule};

/// One tool's endpoint fan-out (camelCase JSON keys). An empty `methods` list
/// means "any method".
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogTool {
    host_pattern: String,
    paths: Vec<String>,
    methods: Vec<String>,
}

type Catalog = HashMap<String, HashMap<String, CatalogTool>>;

const BASE_CATALOG_JSON: &str = include_str!("catalog.generated.json");

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| serde_json::from_str(BASE_CATALOG_JSON).expect("parse base catalog"))
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

/// A throwaway `policy::PolicyRule` so one path×method variant routes through
/// the gateway's exact `matches_request` (the action is irrelevant to
/// matching). Conditions ride from the owning rule — vacuous in OSS, where the
/// `condition_match` arm is the no-op.
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

/// Does the request hit the app target? The host decision defers to the
/// **injection registry** (`crate::apps`), the authority for what traffic is the
/// app's — so a rule governs exactly the hosts the app's credential is injected
/// on and can't fall short of it (the class where a request is credentialed but
/// no rule matches it, e.g. Gmail's legacy `www.googleapis.com/gmail/` mirror of
/// `gmail.googleapis.com`). It is a UNION with the catalog's own tool host, so it
/// only ever widens matching (never drops an existing match) and still covers a
/// catalog provider absent from the injection registry. Unknown provider or tool
/// id → false (fail-closed).
///
/// - **Whole-app** (empty tools): matches any host the app injects on — the app's
///   FULL injection surface, including a broad credential zone like AWS's
///   `*.amazonaws.com`.
/// - **Tool-scoped**: a tool matches on its own catalog host OR an injection
///   **mirror** of the app — a path-scoped mirror (`www.googleapis.com/gmail/`),
///   or, for a single-host-family app (all tools on one host), any host the app
///   injects on (its regional/apex twins, e.g. datadog `.datadoghq.eu`, sentry
///   apex) — then its path×method. It deliberately does NOT fold a MULTI-host
///   injection zone (AWS's per-service `*.amazonaws.com`), so a tool rule can't
///   bleed across sibling services. A truly distinct endpoint host (github
///   `raw.githubusercontent.com`, fly.io GraphQL) is a separate catalog tool of
///   its own; whole-app rules also cover it.
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

    fn matches(provider: &str, tools: &[&str], host: &str, method: &str, path: &str) -> bool {
        let tools: Vec<String> = tools.iter().map(|s| s.to_string()).collect();
        app_target_matches(provider, &tools, host, method, path, None, &None)
    }

    #[test]
    fn named_tool_matches_exactly_its_endpoint_fanout() {
        // github create_issue = POST api.github.com /repos/*/*/issues.
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
            "api.github.com",
            "GET",
            "/repos/o/r/issues"
        ));
        assert!(!matches(
            "github",
            &["create_issue"],
            "uploads.github.com",
            "POST",
            "/repos/o/r/issues"
        ));
    }

    #[test]
    fn empty_tools_is_whole_app_host_only() {
        assert!(matches(
            "github",
            &[],
            "api.github.com",
            "DELETE",
            "/anything"
        ));
        assert!(!matches("github", &[], "api.example.com", "GET", "/"));
    }

    #[test]
    fn unknown_provider_and_tool_fail_closed() {
        assert!(!matches("no-such-app", &[], "api.github.com", "GET", "/"));
        assert!(!matches(
            "github",
            &["no_such_tool"],
            "api.github.com",
            "GET",
            "/"
        ));
    }

    // ── Injection-surface coverage (credential-injection bypass fix) ──────────
    // The host decision folds in the injection registry so a rule governs every
    // host the app's credential is injected on — closing the legacy-alias class
    // (`www.googleapis.com/gmail/...`) where a request was credentialed but no
    // rule matched it.

    #[test]
    fn gmail_rule_covers_the_legacy_www_endpoint() {
        // The reported bypass: Gmail injects on gmail.googleapis.com AND the
        // legacy www.googleapis.com/gmail/*, but the catalog lists only the
        // former. Both a whole-app and a tool-scoped Gmail rule must now match
        // the legacy host (so a Block rule denies it), while the primary host
        // still matches unchanged.
        let path = "/gmail/v1/users/me/drafts";
        // Whole-app.
        assert!(matches("gmail", &[], "www.googleapis.com", "POST", path));
        assert!(matches("gmail", &[], "gmail.googleapis.com", "POST", path));
        // Tool-scoped (create_draft = POST /gmail/v1/users/*/drafts).
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
        // A non-Gmail path on the shared host is NOT Gmail's traffic.
        assert!(!matches(
            "gmail",
            &[],
            "www.googleapis.com",
            "GET",
            "/calendar/v3/calendars"
        ));
    }

    #[test]
    fn aws_whole_app_covers_uncataloged_services_but_tool_scope_stays_precise() {
        // AWS injects SigV4 on the whole `*.amazonaws.com` zone, but the catalog
        // lists only ~10 services. A WHOLE-APP AWS rule must cover an
        // uncataloged service (rds) — closing the highest-impact bypass...
        assert!(matches(
            "aws",
            &[],
            "rds.us-east-1.amazonaws.com",
            "POST",
            "/"
        ));
        // ...but a TOOL-scoped AWS rule must NOT bleed onto a sibling service
        // (AWS's rule is a bare suffix with no path prefix), even though the
        // tool's path pattern is a wildcard. It still matches its own service.
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

    #[test]
    fn catalog_only_provider_is_unaffected() {
        // A provider matched purely via its catalog host (no broader injection
        // surface) keeps matching exactly as before — the union never narrows.
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
    fn distinct_endpoint_hosts_are_now_their_own_tools() {
        // The alternate-access hosts are cataloged as their own tools, so a
        // TOOL-scoped rule can target them (and whole-app/wildcard cover them).
        // github raw file content — reading a private file via raw is governed.
        assert!(matches(
            "github",
            &["read_raw_content"],
            "raw.githubusercontent.com",
            "GET",
            "/owner/repo/main/secrets.txt"
        ));
        // The raw tool does not leak onto the API host (different tool there).
        assert!(!matches(
            "github",
            &["read_raw_content"],
            "api.github.com",
            "GET",
            "/repos/o/r/contents/x"
        ));
        // fly.io GraphQL control-plane endpoint.
        assert!(matches(
            "flyio",
            &["graphql"],
            "api.fly.io",
            "POST",
            "/graphql"
        ));
    }

    /// The invariant (enforcement ⊇ injection): for EVERY provider the gateway
    /// injects credentials for, a WHOLE-APP rule for that provider must match a
    /// request on each host it injects on. This is the structural guarantee that
    /// the two host lists can't diverge into a bypass again — it fails if the
    /// engine regresses to catalog-only matching, or an injection host is added
    /// that the app-target matcher can't reach.
    #[test]
    fn whole_app_rules_cover_the_entire_injection_surface() {
        for (provider, host, path) in crate::apps::injection_surface_samples() {
            // Only providers with a permission catalog are targetable by an
            // app/connection rule (no tools → no rule); the rest have no
            // enforcement surface to diverge from.
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
