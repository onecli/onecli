//! Decode loaded published `policy_rules_v2` rows into the engine's `NewRule`
//! list. The rows are already new-model, so this is a direct decode. Each scope
//! carries its own `priority` sequence; the evaluator combines the two levels.

use db::{ConnectionProviders, PolicyIdentityRow, PolicyRuleV2Row, PolicyTargetRow, SecretHosts};

use super::types::{Action, Identity, NewRule, RateWindow, Scope, Target};

/// Decode each identity row to its `Identity` variant. Exactly one principal
/// column is set (the DB `one_principal` CHECK); the directory kinds
/// (user/group, step 6) are matched against the connection's resolved
/// principal set. A row with no principal → `Unresolved` (never matches;
/// unreachable given the CHECK). The rows were parsed from the aggregate JSON at
/// LOAD (`Json<Vec<…>>` on `PolicyRuleV2Row`); here we only map, so the
/// per-request path never re-parses JSON.
fn decode_identities(rows: &[PolicyIdentityRow]) -> Vec<Identity> {
    rows.iter()
        .map(|r| {
            if let Some(id) = &r.agent_id {
                Identity::Agent(id.clone())
            } else if let Some(id) = &r.user_id {
                Identity::User(id.clone())
            } else if let Some(id) = &r.group_id {
                Identity::Group(id.clone())
            } else {
                Identity::Unresolved
            }
        })
        .collect()
}

/// `network`/`app`/`secret`/`connection` → the matchable targets; an unknown kind
/// → `Unresolved`. A `secret` target resolves to its credential's host pattern(s)
/// via `secret_hosts`; a `connection` target resolves through `connection_providers`
/// (both loaded at connect) to a `Target::Connection` that KEEPS the id — the
/// decision binds to the connection that wins injection — carrying the target's
/// own `app_tools` (empty = the whole app, host-only; named = the tool fan-out,
/// honoring path/method/conditions — the same expansion as an app target). A
/// missing/deleted/foreign connection id isn't in the fenced map → `Unresolved`
/// (never matches — fail-closed, like a deleted secret).
fn decode_targets(
    rows: &[PolicyTargetRow],
    secret_hosts: &SecretHosts,
    connection_providers: &ConnectionProviders,
) -> Vec<Target> {
    rows.iter()
        .map(|r| match r.kind.as_str() {
            "network" => Target::Network {
                host_pattern: r.host_pattern.clone().unwrap_or_default(),
                path_pattern: r.path_pattern.clone(),
                method: r.method.clone(),
            },
            "app" => match &r.app_provider {
                Some(provider) => Target::App {
                    provider: provider.clone(),
                    tools: r.app_tools.clone(),
                },
                None => Target::Unresolved,
            },
            "connection" => match r
                .app_connection_id
                .as_ref()
                .and_then(|id| connection_providers.by_id.get(id).map(|p| (id, p)))
            {
                // The id binds the decision to the connection that wins
                // injection; the target's own `app_tools` narrow which
                // endpoints match (empty = the connection's whole app).
                // Injection selection is separate (`inject_select`).
                Some((id, provider)) => Target::Connection {
                    id: id.clone(),
                    provider: provider.clone(),
                    tools: r.app_tools.clone(),
                },
                None => Target::Unresolved,
            },
            "secret" => Target::Secret {
                host_patterns: secret_target_hosts(r, secret_hosts),
            },
            _ => Target::Unresolved,
        })
        .collect()
}

/// Resolve a `secret` target to the host pattern(s) it gates. A specific
/// `secret_id` → its host pattern(s) — a typed secret (OpenAI) covers several
/// (absent/deleted from the fenced set → none, so the target never matches —
/// fail-closed); a `secret_scope` → the union of the
/// org/workspace secrets' hosts (step 8). `secret_hosts` is org/workspace-fenced at
/// connect (`find_secret_hosts`), so a forged id/scope resolves to nothing.
fn secret_target_hosts(r: &PolicyTargetRow, secret_hosts: &SecretHosts) -> Vec<String> {
    if let Some(id) = &r.secret_id {
        secret_hosts.by_id.get(id).cloned().unwrap_or_default()
    } else if let Some(scope) = &r.secret_scope {
        match scope.as_str() {
            "workspace" => secret_hosts.workspace_hosts.clone(),
            "organization" => secret_hosts.org_hosts.clone(),
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    }
}

fn rate_window(name: Option<&str>) -> Option<RateWindow> {
    match name {
        Some("minute") => Some(RateWindow::Minute),
        Some("hour") => Some(RateWindow::Hour),
        Some("day") => Some(RateWindow::Day),
        _ => None,
    }
}

/// Decode one loaded v2 row into a `NewRule`. `scope` comes from which loader
/// produced it. A malformed rate limit (≤ 0 or unknown window) is dropped to a
/// plain allow, matching the translator + the old gateway.
fn decode_row(
    row: &PolicyRuleV2Row,
    scope: Scope,
    secret_hosts: &SecretHosts,
    connection_providers: &ConnectionProviders,
) -> NewRule {
    NewRule {
        id: row.id.clone(),
        logical_id: row.logical_id.clone(),
        name: row.name.clone(),
        scope,
        priority: usize::try_from(row.priority).unwrap_or(0),
        is_default: row.is_default,
        identities: decode_identities(&row.identities.0),
        targets: decode_targets(&row.targets.0, secret_hosts, connection_providers),
        action: if row.action == "block" {
            Action::Block
        } else {
            Action::Allow
        },
        require_approval: row.require_approval,
        rate_limit: row
            .rate_limit
            .and_then(|v| u64::try_from(v).ok())
            .filter(|&v| v > 0),
        rate_limit_window: rate_window(row.rate_limit_window.as_deref()),
        conditions: row.conditions.clone(),
    }
}

/// Assemble the (borrowed) org + workspace loaded rows into the new-model rule list
/// the evaluator walks. Borrowed because the rows live in the resolved bundle
/// (loaded at connection resolution) and are decoded per request off the hot path.
///
/// `source="equipment"` rows (step 8) are DROPPED here by SOURCE: they materialize
/// the equipment/injection model — their connection/secret target names a credential
/// to inject at connect, not a policy grant — so the block/allow engine must not see
/// them. Dropping by source is load-bearing now that a `secret` target PERMITS its
/// host: an undropped equipment secret rule would wrongly grant its host. It also
/// neutralizes a rule orphaned to zero targets by an FK cascade when its
/// secret/connection is deleted (the Layer-1 empty-targets guard catches that too).
pub(super) fn assemble_v2(
    org_rows: &[PolicyRuleV2Row],
    workspace_rows: &[PolicyRuleV2Row],
    secret_hosts: &SecretHosts,
    connection_providers: &ConnectionProviders,
) -> Vec<NewRule> {
    org_rows
        .iter()
        .filter(|row| row.source != "equipment")
        .map(|row| decode_row(row, Scope::Organization, secret_hosts, connection_providers))
        .chain(
            workspace_rows
                .iter()
                .filter(|row| row.source != "equipment")
                .map(|row| decode_row(row, Scope::Workspace, secret_hosts, connection_providers)),
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::types::Json;

    fn row(
        action: &str,
        identities: serde_json::Value,
        targets: serde_json::Value,
    ) -> PolicyRuleV2Row {
        // The rows arrive pre-decoded (Json<Vec<…>>); parse the fixture JSON the
        // same way the load path does.
        PolicyRuleV2Row {
            id: "r1".to_string(),
            logical_id: "lr1".to_string(),
            name: "rule".to_string(),
            source: "custom".to_string(),
            priority: 3,
            is_default: false,
            action: action.to_string(),
            rate_limit: None,
            rate_limit_window: None,
            require_approval: false,
            conditions: None,
            identities: Json(serde_json::from_value(identities).unwrap_or_default()),
            targets: Json(serde_json::from_value(targets).unwrap_or_default()),
        }
    }

    #[test]
    fn decodes_agent_identity_and_network_target() {
        let rows = vec![row(
            "block",
            json!([{ "agentId": "a1", "userId": null, "groupId": null }]),
            json!([{ "kind": "network", "hostPattern": "api.example.com", "pathPattern": "/*", "method": "GET" }]),
        )];
        let rules = assemble_v2(
            &[],
            &rows,
            &SecretHosts::default(),
            &ConnectionProviders::default(),
        );
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].action, Action::Block);
        assert_eq!(rules[0].scope, Scope::Workspace);
        assert_eq!(rules[0].priority, 3);
        match &rules[0].identities[..] {
            [Identity::Agent(id)] => assert_eq!(id, "a1"),
            other => panic!("expected one agent identity, got {other:?}"),
        }
        match &rules[0].targets[..] {
            [Target::Network {
                host_pattern,
                method,
                ..
            }] => {
                assert_eq!(host_pattern, "api.example.com");
                assert_eq!(method.as_deref(), Some("GET"));
            }
            other => panic!("expected one network target, got {other:?}"),
        }
    }

    #[test]
    fn decodes_app_target() {
        let rows = vec![row(
            "allow",
            json!([]),
            json!([{ "kind": "app", "appProvider": "gmail", "appTools": ["read_emails"] }]),
        )];
        let rules = assemble_v2(
            &rows,
            &[],
            &SecretHosts::default(),
            &ConnectionProviders::default(),
        );
        assert_eq!(rules[0].scope, Scope::Organization);
        match &rules[0].targets[..] {
            [Target::App { provider, tools }] => {
                assert_eq!(provider, "gmail");
                assert_eq!(tools, &["read_emails".to_string()]);
            }
            other => panic!("expected one app target, got {other:?}"),
        }
    }

    #[test]
    fn decodes_directory_identities() {
        // Step 6: user / group identities decode to their own
        // variants (matched against the connection's principal set), no longer
        // `Unresolved`.
        let rows = vec![
            row(
                "allow",
                json!([{ "agentId": null, "userId": "u1", "groupId": null }]),
                json!([]),
            ),
            row(
                "allow",
                json!([{ "agentId": null, "userId": null, "groupId": "g1" }]),
                json!([]),
            ),
        ];
        let rules = assemble_v2(
            &rows,
            &[],
            &SecretHosts::default(),
            &ConnectionProviders::default(),
        );
        assert!(matches!(&rules[0].identities[..], [Identity::User(id)] if id == "u1"));
        assert!(matches!(&rules[1].identities[..], [Identity::Group(id)] if id == "g1"));
    }

    #[test]
    fn connection_target_resolves_to_its_connection() {
        // A connection target decodes through the fenced connect-time provider
        // map to a `Connection` target that KEEPS the id — decisions bind to
        // the connection that wins injection (no tools → the provider's whole
        // app, host-only, same expansion as `App`).
        let providers = ConnectionProviders {
            by_id: [("c1".to_string(), "gmail".to_string())]
                .into_iter()
                .collect(),
        };
        let rows = vec![row(
            "allow",
            json!([{ "agentId": null, "userId": null, "groupId": "g1" }]),
            json!([{ "kind": "connection", "appConnectionId": "c1" }]),
        )];
        let rules = assemble_v2(&[], &rows, &SecretHosts::default(), &providers);
        assert!(matches!(&rules[0].identities[..], [Identity::Group(id)] if id == "g1"));
        match &rules[0].targets[..] {
            [Target::Connection {
                id,
                provider,
                tools,
            }] => {
                assert_eq!(id, "c1");
                assert_eq!(provider, "gmail");
                assert!(tools.is_empty());
            }
            other => panic!("expected a connection target, got {other:?}"),
        }
    }

    #[test]
    fn connection_target_unresolved_when_missing_from_fenced_map() {
        // A connection id absent from the fenced map (deleted in the cache window,
        // or a forged/foreign id the fence excluded) → `Unresolved` (never
        // matches — fail-closed, like a deleted secret).
        let rows = vec![row(
            "allow",
            json!([]),
            json!([{ "kind": "connection", "appConnectionId": "gone" }]),
        )];
        let rules = assemble_v2(
            &[],
            &rows,
            &SecretHosts::default(),
            &ConnectionProviders::default(),
        );
        assert!(matches!(rules[0].targets[..], [Target::Unresolved]));
    }

    #[test]
    fn equipment_source_rules_are_dropped_from_block_allow() {
        // Injection-only: an `equipment` rule (even a well-formed allow) must not
        // reach the block/allow engine. A `custom` sibling is kept.
        let mut equip = row("allow", json!([]), json!([]));
        equip.source = "equipment".to_string();
        let keep = row("block", json!([]), json!([]));
        let rules = assemble_v2(
            &[equip, keep],
            &[],
            &SecretHosts::default(),
            &ConnectionProviders::default(),
        );
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].action, Action::Block);
    }

    #[test]
    fn decodes_rate_limit_and_drops_malformed() {
        let mut good = row("allow", json!([]), json!([]));
        good.rate_limit = Some(100);
        good.rate_limit_window = Some("hour".to_string());
        let mut bad = row("allow", json!([]), json!([]));
        bad.rate_limit = Some(0); // malformed → dropped
        bad.rate_limit_window = Some("hour".to_string());
        let rules = assemble_v2(
            &[good, bad],
            &[],
            &SecretHosts::default(),
            &ConnectionProviders::default(),
        );
        assert_eq!(rules[0].rate_limit, Some(100));
        assert_eq!(rules[0].rate_limit_window, Some(RateWindow::Hour));
        assert_eq!(rules[1].rate_limit, None);
    }
}
