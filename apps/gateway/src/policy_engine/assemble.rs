//! Decode the loaded published project rows into the evaluator's `Rule` list.
//! The rows are already new-model; this maps shapes and resolves
//! connection/secret targets through the fenced connect-time maps.

use crate::db::{
    ConnectionProviders, PolicyIdentityRow, PolicyRuleV2Row, PolicyTargetRow, SecretHosts,
};

use super::types::{Action, Identity, RateWindow, Rule, Target};

/// Agent identities match by id; every other principal kind is a OneCLI Cloud
/// capability and decodes to `Other`, which never matches — a stored directory
/// identity narrows its rule to nothing rather than widening it (fail-closed).
fn decode_identities(rows: &[PolicyIdentityRow]) -> Vec<Identity> {
    rows.iter()
        .map(|r| match &r.agent_id {
            Some(id) => Identity::Agent(id.clone()),
            None => Identity::Other,
        })
        .collect()
}

/// Resolve a `secret` target to the host pattern(s) it gates: a specific
/// `secret_id` via the fenced by-id map (absent/deleted → none → never
/// matches), or a `secret_scope` level union. The maps are project-fenced at
/// load, so a forged/foreign id resolves to nothing.
fn secret_target_hosts(r: &PolicyTargetRow, secret_hosts: &SecretHosts) -> Vec<String> {
    if let Some(id) = &r.secret_id {
        secret_hosts.by_id.get(id).cloned().into_iter().collect()
    } else if let Some(scope) = &r.secret_scope {
        match scope.as_str() {
            "project" => secret_hosts.project_hosts.clone(),
            "organization" => secret_hosts.org_hosts.clone(),
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    }
}

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
            // A connection target decodes to its provider's app (the target's
            // own tools narrow which endpoints match; empty = the whole app).
            // A missing/deleted/foreign id is not in the fenced map →
            // `Unresolved` (never matches — fail-closed).
            "connection" => match r
                .app_connection_id
                .as_ref()
                .and_then(|id| connection_providers.by_id.get(id))
            {
                Some(provider) => Target::App {
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

fn rate_window(name: Option<&str>) -> Option<RateWindow> {
    match name {
        Some("minute") => Some(RateWindow::Minute),
        Some("hour") => Some(RateWindow::Hour),
        Some("day") => Some(RateWindow::Day),
        _ => None,
    }
}

fn decode_row(
    row: &PolicyRuleV2Row,
    secret_hosts: &SecretHosts,
    connection_providers: &ConnectionProviders,
) -> Rule {
    Rule {
        id: row.id.clone(),
        logical_id: row.logical_id.clone(),
        name: row.name.clone(),
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
        // A malformed rate limit (≤ 0 or an unknown window) drops to a plain
        // allow, matching the legacy loader.
        rate_limit: row
            .rate_limit
            .and_then(|v| u64::try_from(v).ok())
            .filter(|&v| v > 0),
        rate_limit_window: rate_window(row.rate_limit_window.as_deref()),
        conditions: row.conditions.clone(),
    }
}

/// Assemble the loaded project rows for the evaluator. `source="equipment"`
/// rows are injection-only — their connection/secret target names a credential
/// to inject at connect, not a policy grant — and are DROPPED here. That drop
/// is load-bearing: a `secret` target PERMITS its host, so an undropped
/// equipment rule would silently grant network access alongside its injection.
pub(super) fn assemble(
    project_rows: &[PolicyRuleV2Row],
    secret_hosts: &SecretHosts,
    connection_providers: &ConnectionProviders,
) -> Vec<Rule> {
    project_rows
        .iter()
        .filter(|row| row.source != "equipment")
        .map(|row| decode_row(row, secret_hosts, connection_providers))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::types::Json;

    fn row(over: impl FnOnce(&mut PolicyRuleV2Row)) -> PolicyRuleV2Row {
        let mut r = PolicyRuleV2Row {
            id: "r1".to_string(),
            logical_id: "l1".to_string(),
            name: "rule".to_string(),
            source: "custom".to_string(),
            priority: 0,
            is_default: false,
            action: "allow".to_string(),
            rate_limit: None,
            rate_limit_window: None,
            require_approval: false,
            conditions: None,
            identities: Json(Vec::new()),
            targets: Json(Vec::new()),
        };
        over(&mut r);
        r
    }

    fn target(v: serde_json::Value) -> PolicyTargetRow {
        serde_json::from_value(v).expect("target row")
    }

    #[test]
    fn equipment_rows_are_dropped_from_the_decision_walk() {
        let rows = vec![
            row(|r| r.source = "equipment".to_string()),
            row(|r| r.id = "keep".to_string()),
        ];
        let rules = assemble(
            &rows,
            &SecretHosts::default(),
            &ConnectionProviders::default(),
        );
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, "keep");
    }

    #[test]
    fn directory_identities_decode_to_other_never_agent() {
        let rows = vec![row(|r| {
            r.identities = Json(vec![serde_json::from_value(
                json!({"agentId": null, "agentGroupId": "g1", "userId": null, "groupId": null}),
            )
            .expect("identity row")]);
        })];
        let rules = assemble(
            &rows,
            &SecretHosts::default(),
            &ConnectionProviders::default(),
        );
        assert!(matches!(rules[0].identities[0], Identity::Other));
    }

    #[test]
    fn connection_target_resolves_via_the_fenced_map_else_unresolved() {
        let mut providers = ConnectionProviders::default();
        providers
            .by_id
            .insert("c1".to_string(), "github".to_string());
        let rows = vec![row(|r| {
            r.targets = Json(vec![
                target(json!({"kind": "connection", "appConnectionId": "c1", "appTools": []})),
                target(json!({"kind": "connection", "appConnectionId": "missing", "appTools": []})),
            ]);
        })];
        let rules = assemble(&rows, &SecretHosts::default(), &providers);
        assert!(
            matches!(&rules[0].targets[0], Target::App { provider, .. } if provider == "github")
        );
        assert!(matches!(rules[0].targets[1], Target::Unresolved));
    }

    #[test]
    fn secret_target_resolves_hosts_by_id_and_scope() {
        let mut hosts = SecretHosts::default();
        hosts
            .by_id
            .insert("s1".to_string(), "api.example.com".to_string());
        hosts.project_hosts.push("p.example.com".to_string());
        let rows = vec![row(|r| {
            r.targets = Json(vec![
                target(json!({"kind": "secret", "secretId": "s1"})),
                target(json!({"kind": "secret", "secretScope": "project"})),
                target(json!({"kind": "secret", "secretId": "deleted"})),
            ]);
        })];
        let rules = assemble(&rows, &hosts, &ConnectionProviders::default());
        assert!(
            matches!(&rules[0].targets[0], Target::Secret { host_patterns } if host_patterns == &["api.example.com".to_string()])
        );
        assert!(
            matches!(&rules[0].targets[1], Target::Secret { host_patterns } if host_patterns == &["p.example.com".to_string()])
        );
        assert!(
            matches!(&rules[0].targets[2], Target::Secret { host_patterns } if host_patterns.is_empty())
        );
    }

    #[test]
    fn malformed_rate_limit_drops_to_plain_allow() {
        let rows = vec![
            row(|r| {
                r.rate_limit = Some(0);
                r.rate_limit_window = Some("minute".to_string());
            }),
            row(|r| {
                r.rate_limit = Some(5);
                r.rate_limit_window = Some("week".to_string());
            }),
            row(|r| {
                r.rate_limit = Some(5);
                r.rate_limit_window = Some("hour".to_string());
            }),
        ];
        let rules = assemble(
            &rows,
            &SecretHosts::default(),
            &ConnectionProviders::default(),
        );
        assert_eq!(rules[0].rate_limit, None);
        assert_eq!(rules[1].rate_limit_window, None);
        assert_eq!(rules[2].rate_limit, Some(5));
        assert_eq!(rules[2].rate_limit_window, Some(RateWindow::Hour));
    }
}
