//! The OSS inject-selection subset: derive which credentials the published
//! project rules ALLOW the requesting agent to have injected — pure and
//! DB-free over the already-loaded rows. This replaces the equipment join for
//! a SELECTIVE agent after the cutover migrates equipment into rules;
//! `secretMode` stays the all-vs-selective switch.
//!
//! Two locked narrowings vs the EE selector: identities match the AGENT ONLY
//! (no principal set — directory identities are a OneCLI Cloud capability),
//! and a connection's sessionPolicy is NEVER attached (the map value is always
//! `None`) — granular resource scoping is Cloud-only and the OSS gateway has
//! no guard to enforce it, so nothing may ever populate it here.
//!
//! Reads the RAW rows (not the assembler, which resolves connection/secret
//! targets away) so the specific credential ids survive.

use std::collections::{HashMap, HashSet};

use crate::db::{InjectSelection, PolicyIdentityRow, PolicyV2Rules};

/// Injection requires an EXPLICIT agent identity: empty identities NEVER match
/// (a credential must name who receives it — and an agent deleted out of an
/// equipment rule must not leak its credentials to everyone), and directory
/// identity rows never match in OSS.
fn identity_matches(identities: &[PolicyIdentityRow], agent_id: &str) -> bool {
    !identities.is_empty()
        && identities
            .iter()
            .any(|i| i.agent_id.as_deref() == Some(agent_id))
}

/// Derive the agent's inject-selection from the published project rules.
pub(crate) fn derive_inject_selection(rules: &PolicyV2Rules, agent_id: &str) -> InjectSelection {
    let mut secret_ids = HashSet::new();
    let mut connections: HashMap<String, Option<serde_json::Value>> = HashMap::new();
    let mut app_scopes = Vec::new();
    let mut secret_scopes = Vec::new();
    for row in &rules.project {
        if row.action != "allow" {
            continue;
        }
        if !identity_matches(&row.identities.0, agent_id) {
            continue;
        }
        for t in &row.targets.0 {
            match t.kind.as_str() {
                "secret" => {
                    if let Some(id) = &t.secret_id {
                        secret_ids.insert(id.clone());
                    } else if let Some(scope) = &t.secret_scope {
                        secret_scopes.push(scope.clone());
                    }
                }
                "connection" => {
                    if let Some(id) = &t.app_connection_id {
                        // ALWAYS `None`: sessionPolicy must never attach in OSS
                        // (see the module doc).
                        connections.insert(id.clone(), None);
                    }
                }
                "app" => {
                    // With a connection_scope this is the "all the agent's
                    // connections of `provider` at that level" instruction;
                    // without one it's a block/allow app rule — no injection.
                    if let (Some(provider), Some(scope)) =
                        (&t.app_provider, &t.app_connection_scope)
                    {
                        app_scopes.push((provider.clone(), scope.clone()));
                    }
                }
                _ => {}
            }
        }
    }
    InjectSelection {
        secret_ids,
        connections,
        app_scopes,
        secret_scopes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::PolicyRuleV2Row;
    use serde_json::json;
    use sqlx::types::Json;

    fn rule(
        action: &str,
        identities: serde_json::Value,
        targets: serde_json::Value,
    ) -> PolicyRuleV2Row {
        PolicyRuleV2Row {
            id: "r1".to_string(),
            logical_id: "l1".to_string(),
            name: "rule".to_string(),
            source: "equipment".to_string(),
            priority: 0,
            is_default: false,
            action: action.to_string(),
            rate_limit: None,
            rate_limit_window: None,
            require_approval: false,
            conditions: Some(json!({ "repositories": ["o/r"] })),
            identities: Json(serde_json::from_value(identities).expect("identities")),
            targets: Json(serde_json::from_value(targets).expect("targets")),
        }
    }

    fn v2(rules: Vec<PolicyRuleV2Row>) -> PolicyV2Rules {
        PolicyV2Rules {
            project: rules,
            ..PolicyV2Rules::default()
        }
    }

    fn agent_identity(id: &str) -> serde_json::Value {
        json!([{ "agentId": id, "agentGroupId": null, "userId": null, "groupId": null }])
    }

    #[test]
    fn collects_the_named_agents_secrets_and_connections_only() {
        let rules = v2(vec![
            rule(
                "allow",
                agent_identity("a1"),
                json!([
                    { "kind": "secret", "secretId": "s1" },
                    { "kind": "connection", "appConnectionId": "c1", "appTools": [] },
                ]),
            ),
            rule(
                "allow",
                agent_identity("someone-else"),
                json!([{ "kind": "secret", "secretId": "foreign" }]),
            ),
        ]);
        let sel = derive_inject_selection(&rules, "a1");
        assert!(sel.secret_ids.contains("s1"));
        assert!(!sel.secret_ids.contains("foreign"));
        assert!(sel.connections.contains_key("c1"));
    }

    #[test]
    fn block_rules_and_empty_identities_never_inject() {
        let rules = v2(vec![
            rule(
                "block",
                agent_identity("a1"),
                json!([{ "kind": "secret", "secretId": "s1" }]),
            ),
            // Empty identity ("any" for block/allow) must NOT inject — the
            // orphaned-equipment leak guard.
            rule(
                "allow",
                json!([]),
                json!([{ "kind": "secret", "secretId": "s2" }]),
            ),
        ]);
        let sel = derive_inject_selection(&rules, "a1");
        assert!(sel.secret_ids.is_empty());
    }

    #[test]
    fn directory_identity_rows_never_inject_in_oss() {
        let rules = v2(vec![rule(
            "allow",
            json!([{ "agentId": null, "agentGroupId": "g1", "userId": null, "groupId": null }]),
            json!([{ "kind": "secret", "secretId": "s1" }]),
        )]);
        assert!(derive_inject_selection(&rules, "a1").secret_ids.is_empty());
    }

    #[test]
    fn session_policy_is_never_attached() {
        // The fixture rule carries conditions (a granular session policy); the
        // selection must still map the connection to `None`.
        let rules = v2(vec![rule(
            "allow",
            agent_identity("a1"),
            json!([{ "kind": "connection", "appConnectionId": "c1", "appTools": [] }]),
        )]);
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(sel.connections.get("c1"), Some(&None));
    }

    #[test]
    fn scope_channels_collect_levels() {
        let rules = v2(vec![rule(
            "allow",
            agent_identity("a1"),
            json!([
                { "kind": "secret", "secretScope": "project" },
                { "kind": "app", "appProvider": "github", "appConnectionScope": "project", "appTools": [] },
                { "kind": "app", "appProvider": "gmail", "appTools": [] },
            ]),
        )]);
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(sel.secret_scopes, vec!["project".to_string()]);
        assert_eq!(
            sel.app_scopes,
            vec![("github".to_string(), "project".to_string())]
        );
    }
}
