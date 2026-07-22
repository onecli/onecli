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

/// Does the request hit the app target? Named tools match when the request host
/// matches the tool's host AND any of its path×method variants matches. An
/// EMPTY tool set is the WHOLE app: host-only against every catalog tool host
/// of the provider (any path/method). Unknown provider or tool id → false
/// (fail-closed).
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
            .any(|tool| host_matches(request_host, &tool.host_pattern));
    }
    tools.iter().any(|tool_id| {
        let Some(tool) = provider_tools.get(tool_id) else {
            return false;
        };
        if !host_matches(request_host, &tool.host_pattern) {
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
}
