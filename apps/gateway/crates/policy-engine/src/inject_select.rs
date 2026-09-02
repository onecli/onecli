//! Step-8 inject-selection: derive the specific credentials a connect's published
//! v2 rules ALLOW the requesting agent to have injected, from the already-loaded
//! `PolicyV2Rules` — pure and DB-free, so it stays off the per-request path.
//!
//! This is the connect-time SELECTION that replaced the legacy per-agent
//! grant join (those tables are dropped); since attach-model step 7 it is the
//! whole story — every agent is rule-selected (`connect.rs`).
//! Injection is a UNION (order-independent), so we walk every ALLOW rule whose
//! identity EXPLICITLY matches the agent (its own id, or an inherited
//! user / group in the connect-resolved `PrincipalSet` — never "any";
//! see `identity_matches`) and collect its connection/secret target ids. A
//! `connection` target carries its
//! rule's `conditions` as the sessionPolicy (the granular guard). Both
//! `equipment`-source rules (the backfilled allowlist) and v2-authored `custom`
//! connection/secret rules feed it.
//!
//! Reads the RAW rows (not `assemble::decode_row`, which maps connection/secret
//! targets to `Unresolved` and drops their ids) so the specific ids survive.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

use db::{InjectSelection, PolicyIdentityRow, PolicyRuleV2Row, PolicyV2Rules, PrincipalSet};
use ee::granular_access;

/// Whether a rule's identities match the requesting agent — its own id, or an
/// inherited user / group in its principal set.
///
/// Injection requires an EXPLICIT identity: an injection rule names WHO receives
/// the credential, so — unlike the block/allow engine, where empty identities mean
/// "any" — an EMPTY identity here is NEVER a match. That is both a safety choice (a
/// credential should not inject to every agent) and the orphan guard: if an agent
/// is deleted, its identity row cascades off the equipment rule, and treating the
/// now-empty identity as "any" would leak that agent's credentials to every other
/// agent. So empty → no match.
fn identity_matches(
    identities: &[PolicyIdentityRow],
    agent_id: &str,
    principals: &PrincipalSet,
) -> bool {
    !identities.is_empty() && principal_matches(identities, agent_id, principals)
}

/// Whether a rule's identities match the agent for the purposes of a RESOURCE
/// BOUNDARY — the decision engine's law, where empty identities mean "every
/// agent".
///
/// The two laws differ because the stakes are opposite. Injection asks "who
/// receives this credential?", so an unnamed rule must never widen it to
/// everyone. A boundary asks "how far may this credential reach?", where an
/// unnamed rule means the organization is restricting everyone — the reading an
/// admin plainly intends, and one that can only ever tighten access.
fn boundary_identity_matches(
    identities: &[PolicyIdentityRow],
    agent_id: &str,
    principals: &PrincipalSet,
) -> bool {
    identities.is_empty() || principal_matches(identities, agent_id, principals)
}

fn principal_matches(
    identities: &[PolicyIdentityRow],
    agent_id: &str,
    principals: &PrincipalSet,
) -> bool {
    identities.iter().any(|i| {
        if let Some(id) = &i.agent_id {
            id == agent_id
        } else if let Some(id) = &i.user_id {
            principals.user_ids.contains(id)
        } else if let Some(id) = &i.group_id {
            principals.group_ids.contains(id)
        } else {
            // No principal (the DB `one_principal` CHECK makes this
            // unreachable) — never widen to "any".
            false
        }
    })
}

/// Fold one scope's matching allow rules' connection/secret targets into the sets.
fn collect(
    rows: &[PolicyRuleV2Row],
    agent_id: &str,
    principals: &PrincipalSet,
    secret_ids: &mut HashSet<String>,
    connections: &mut HashMap<String, Option<serde_json::Value>>,
    app_scopes: &mut Vec<(String, String)>,
    secret_scopes: &mut Vec<String>,
) {
    for row in rows {
        if row.action != "allow" {
            continue;
        }
        if !identity_matches(&row.identities.0, agent_id, principals) {
            continue;
        }
        for t in &row.targets.0 {
            match t.kind.as_str() {
                "secret" => {
                    // A secret target names EITHER a specific secret OR "all
                    // secrets at a level" (its `secret_scope`) — exactly one, per
                    // the kind_shape CHECK. The scope-based form is the secret
                    // mirror of the `app` connection_scope.
                    if let Some(id) = &t.secret_id {
                        secret_ids.insert(id.clone());
                    } else if let Some(scope) = &t.secret_scope {
                        secret_scopes.push(scope.clone());
                    }
                }
                "connection" => {
                    if let Some(id) = &t.app_connection_id {
                        // The rule's conditions ride as the connection's
                        // sessionPolicy (the equipment backfill emits one rule per
                        // connection; last match wins WITHIN one scope — across
                        // scopes `derive_inject_selection` intersects). The
                        // block/allow engine separately gates the connection's
                        // provider hosts — this arm stays the injection side of
                        // that symmetry.
                        connections.insert(id.clone(), row.conditions.clone());
                    }
                }
                "app" => {
                    // A kind=app target WITH a connection_scope is an injection
                    // instruction ("all the agent's connections of `provider` at
                    // that level"); WITHOUT one it's a block/allow app-permission
                    // rule (no injection) and is skipped here.
                    if let (Some(provider), Some(scope)) =
                        (&t.app_provider, &t.app_connection_scope)
                    {
                        app_scopes.push((provider.clone(), scope.clone()));
                    }
                }
                // network targets name no credential.
                _ => {}
            }
        }
    }
}

/// The ORG resource boundaries that apply to this agent: the session policy of
/// every org allow rule naming a connection, under the DECISION identity law.
///
/// Separate from `collect` on purpose. The org fold there both GRANTS
/// credentials and carries their policies, and granting must stay
/// explicit-identity-only; boundaries alone may come from rules that name
/// nobody, because restricting everyone is always safe. Feeding these into the
/// grant map instead would hand every unnamed org rule's credential to every
/// agent.
fn collect_boundaries(
    rows: &[PolicyRuleV2Row],
    agent_id: &str,
    principals: &PrincipalSet,
    boundaries: &mut HashMap<String, serde_json::Value>,
) {
    for row in rows {
        if row.action != "allow" {
            continue;
        }
        if !boundary_identity_matches(&row.identities.0, agent_id, principals) {
            continue;
        }
        // Only a row that actually RESTRICTS is a boundary. Deliberately NOT
        // last-match-wins like `collect`: a plain org attach of the same
        // connection carries no policy, and letting it overwrite would erase a
        // real boundary purely because it sorted later — the effective scope
        // would then depend on unrelated rule ordering.
        let Some(policy) = as_resource_policy(&row.conditions) else {
            continue;
        };
        for t in &row.targets.0 {
            if t.kind == "connection" {
                if let Some(id) = &t.app_connection_id {
                    // Several org rules may each constrain the same connection;
                    // every one of them applies, so they compose.
                    let composed = match boundaries.get(id) {
                        Some(existing) => {
                            granular_access::intersect_policies(Some(existing), Some(policy))
                        }
                        None => Some(policy.clone()),
                    };
                    if let Some(composed) = composed {
                        boundaries.insert(id.clone(), composed);
                    }
                }
            }
        }
    }
}

/// A resource policy for composition: object conditions only. A published
/// condition-less row stores jsonb null (decoded as `Some(Value::Null)`) and a
/// behavioral rule stores an array — neither restricts a credential's reach.
fn as_resource_policy(conditions: &Option<serde_json::Value>) -> Option<&serde_json::Value> {
    conditions.as_ref().filter(|v| v.is_object())
}

/// Derive the agent's inject-selection from the connect's published v2 rules.
pub fn derive_inject_selection(rules: &PolicyV2Rules, agent_id: &str) -> InjectSelection {
    let mut secret_ids = HashSet::new();
    let mut org_connections = HashMap::new();
    let mut connections = HashMap::new();
    let mut app_scopes = Vec::new();
    let mut secret_scopes = Vec::new();
    collect(
        &rules.org,
        agent_id,
        &rules.principals,
        &mut secret_ids,
        &mut org_connections,
        &mut app_scopes,
        &mut secret_scopes,
    );
    collect(
        &rules.workspace,
        agent_id,
        &rules.principals,
        &mut secret_ids,
        &mut connections,
        &mut app_scopes,
        &mut secret_scopes,
    );

    // Compose the scopes: the organization sets the OUTER BOUNDARY and the
    // workspace SELECTS within it, so what the credential may reach is the
    // overlap of the two — never the union, and never one silently replacing
    // the other. An empty overlap is meaningful: it denies everything (the
    // credential still injects, so the request is refused rather than passing
    // through unmanaged).
    let mut org_boundaries = HashMap::new();
    collect_boundaries(&rules.org, agent_id, &rules.principals, &mut org_boundaries);

    // Org-granted connections merge in first, carrying their own grant policy.
    for (id, org_policy) in org_connections {
        match connections.entry(id) {
            Entry::Occupied(mut workspace) => {
                let composed = granular_access::intersect_policies(
                    as_resource_policy(&org_policy),
                    as_resource_policy(workspace.get()),
                );
                workspace.insert(composed);
            }
            Entry::Vacant(org_only) => {
                org_only.insert(org_policy);
            }
        }
    }
    // Then every org boundary applies to whatever the agent ended up with —
    // including connections granted purely at workspace level, which is the
    // whole point of a boundary.
    for (id, boundary) in &org_boundaries {
        // Update-only: a boundary never adds a connection, so look the key up
        // rather than cloning it into an entry that would only ever be taken.
        if let Some(selected) = connections.get_mut(id) {
            *selected =
                granular_access::intersect_policies(Some(boundary), as_resource_policy(selected));
        }
    }

    InjectSelection {
        secret_ids,
        connections,
        // Carried onward: a provider-level grant resolves its connections from
        // the database, so those ids are not knowable here — `connect.rs`
        // applies the boundary to them where they appear.
        boundaries: org_boundaries,
        app_scopes,
        secret_scopes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use db::PolicyTargetRow;
    use serde_json::json;
    use sqlx::types::Json;

    fn row(
        action: &str,
        source: &str,
        identities: serde_json::Value,
        targets: serde_json::Value,
        conditions: Option<serde_json::Value>,
    ) -> PolicyRuleV2Row {
        PolicyRuleV2Row {
            id: "r".to_string(),
            logical_id: "lr".to_string(),
            name: "rule".to_string(),
            source: source.to_string(),
            priority: 0,
            is_default: false,
            action: action.to_string(),
            rate_limit: None,
            rate_limit_window: None,
            require_approval: false,
            conditions,
            identities: Json(serde_json::from_value(identities).unwrap_or_default()),
            targets: Json::<Vec<PolicyTargetRow>>(
                serde_json::from_value(targets).unwrap_or_default(),
            ),
        }
    }

    fn agent(id: &str) -> serde_json::Value {
        json!([{ "agentId": id, "userId": null, "groupId": null }])
    }

    fn v2(workspace: Vec<PolicyRuleV2Row>, principals: PrincipalSet) -> PolicyV2Rules {
        v2_scoped(vec![], workspace, principals)
    }

    fn v2_scoped(
        org: Vec<PolicyRuleV2Row>,
        workspace: Vec<PolicyRuleV2Row>,
        principals: PrincipalSet,
    ) -> PolicyV2Rules {
        PolicyV2Rules {
            org,
            workspace,
            principals,
            ..Default::default()
        }
    }

    /// A connection-target allow row. `conditions` uses the PRODUCTION shapes:
    /// a published condition-less row stores jsonb null → `Some(Value::Null)`
    /// (never `None` — `snapshotDraftRules` writes `Prisma.JsonNull`).
    fn conn_allow(
        agent_id: &str,
        connection_id: &str,
        conditions: serde_json::Value,
    ) -> PolicyRuleV2Row {
        row(
            "allow",
            "grant",
            agent(agent_id),
            json!([{ "kind": "connection", "appConnectionId": connection_id }]),
            Some(conditions),
        )
    }

    #[test]
    fn collects_secret_and_connection_targets_for_the_agent() {
        let rules = v2(
            vec![
                row(
                    "allow",
                    "equipment",
                    agent("a1"),
                    json!([{ "kind": "secret", "secretId": "s1" }]),
                    None,
                ),
                row(
                    "allow",
                    "equipment",
                    agent("a1"),
                    json!([{ "kind": "connection", "appConnectionId": "c1" }]),
                    Some(json!({ "folders": ["/x"] })),
                ),
            ],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert!(sel.secret_ids.contains("s1"));
        assert_eq!(sel.secret_ids.len(), 1);
        assert_eq!(
            sel.connections.get("c1"),
            Some(&Some(json!({ "folders": ["/x"] })))
        );
    }

    #[test]
    fn ignores_block_rules_and_other_agents() {
        let rules = v2(
            vec![
                // A block rule (not an allow) — never contributes to injection.
                row(
                    "block",
                    "custom",
                    agent("a1"),
                    json!([{ "kind": "secret", "secretId": "s_block" }]),
                    None,
                ),
                // Another agent's grant — must not leak to a1.
                row(
                    "allow",
                    "equipment",
                    agent("a2"),
                    json!([{ "kind": "secret", "secretId": "s_other" }]),
                    None,
                ),
            ],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert!(sel.secret_ids.is_empty());
        assert!(sel.connections.is_empty());
    }

    #[test]
    fn matches_inherited_group_but_skips_empty_identity() {
        let principals = PrincipalSet {
            user_ids: vec![],
            group_ids: vec!["g1".to_string()],
        };
        let rules = v2(
            vec![
                // Group identity the agent inherits via its principal set → matches.
                row(
                    "allow",
                    "custom",
                    json!([{ "agentId": null, "userId": null, "groupId": "g1" }]),
                    json!([{ "kind": "secret", "secretId": "s_grp" }]),
                    None,
                ),
                // Empty identity (e.g. an equipment rule orphaned when its owning
                // agent was deleted, cascading the identity row) is NOT "any" for
                // injection — it must never leak a credential to every agent.
                row(
                    "allow",
                    "equipment",
                    json!([]),
                    json!([{ "kind": "connection", "appConnectionId": "c_orphan" }]),
                    None,
                ),
            ],
            principals,
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert!(sel.secret_ids.contains("s_grp"));
        assert!(sel.connections.is_empty());
    }

    #[test]
    fn collects_app_scope_for_scoped_app_target_but_not_app_permission() {
        let rules = v2(
            vec![
                // "all connections of gmail at workspace level" → an app_scope.
                row(
                    "allow",
                    "custom",
                    agent("a1"),
                    json!([{ "kind": "app", "appProvider": "gmail", "appConnectionScope": "workspace" }]),
                    None,
                ),
                // An app-permission rule (no connection_scope) is block/allow-only
                // — it must NOT become an injection instruction.
                row(
                    "allow",
                    "app_permission",
                    agent("a1"),
                    json!([{ "kind": "app", "appProvider": "github", "appTools": ["x"] }]),
                    None,
                ),
            ],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.app_scopes,
            vec![("gmail".to_string(), "workspace".to_string())]
        );
        assert!(sel.connections.is_empty());
        assert!(sel.secret_ids.is_empty());
    }

    #[test]
    fn collects_secret_scope_for_scoped_secret_target() {
        let rules = v2(
            vec![
                // "all secrets at org level" → a secret_scope (the secret mirror
                // of the app connection_scope).
                row(
                    "allow",
                    "custom",
                    agent("a1"),
                    json!([{ "kind": "secret", "secretScope": "organization" }]),
                    None,
                ),
                // A specific secret target → a secret id, never a scope.
                row(
                    "allow",
                    "equipment",
                    agent("a1"),
                    json!([{ "kind": "secret", "secretId": "s1" }]),
                    None,
                ),
            ],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(sel.secret_scopes, vec!["organization".to_string()]);
        assert!(sel.secret_ids.contains("s1"));
        assert_eq!(sel.secret_ids.len(), 1);
    }

    // ── Scope composition: org boundary ∩ workspace selection ─────────────────

    /// An org allow rule naming NO identity — the shape an admin writes to mean
    /// "this applies to the whole organization".
    fn org_wide(connection_id: &str, conditions: serde_json::Value) -> PolicyRuleV2Row {
        row(
            "allow",
            "custom",
            json!([]),
            json!([{ "kind": "connection", "appConnectionId": connection_id }]),
            Some(conditions),
        )
    }

    #[test]
    fn org_session_policy_survives_a_condition_less_workspace_grant() {
        // A plain workspace attach publishes jsonb null; it must not clear the
        // organization's restriction.
        let rules = v2_scoped(
            vec![conn_allow("a1", "c1", json!({ "repositories": ["org/a"] }))],
            vec![conn_allow("a1", "c1", json!(null))],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.connections.get("c1"),
            Some(&Some(json!({ "repositories": ["org/a"] })))
        );
    }

    #[test]
    fn the_workspace_narrows_within_the_org_boundary() {
        // THE headline case, exactly as reported: an org rule that applies to
        // every agent allows two repositories; the workspace picks one of them.
        // The agent gets the one — the overlap — not the org's wider list and
        // not an unrestricted credential.
        let rules = v2_scoped(
            vec![org_wide(
                "c1",
                json!({ "repositories": ["buckle/electron", "buckle/api"] }),
            )],
            vec![conn_allow(
                "a1",
                "c1",
                json!({ "repositories": ["buckle/api"] }),
            )],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.connections.get("c1"),
            Some(&Some(json!({ "repositories": ["buckle/api"] })))
        );
    }

    #[test]
    fn an_org_wide_boundary_binds_but_never_grants() {
        // The leak pin. An org rule naming nobody restricts every agent, yet it
        // must not hand its connection to an agent the workspace never attached —
        // injection stays explicit-identity-only.
        let rules = v2_scoped(
            vec![org_wide(
                "c_unattached",
                json!({ "repositories": ["org/a"] }),
            )],
            vec![],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert!(sel.connections.is_empty());
    }

    #[test]
    fn a_workspace_pick_outside_the_org_boundary_denies_everything() {
        // Fail closed: the credential still injects (so the request is refused
        // rather than sailing past unmanaged) but reaches nothing.
        let rules = v2_scoped(
            vec![org_wide("c1", json!({ "repositories": ["org/a"] }))],
            vec![conn_allow("a1", "c1", json!({ "repositories": ["org/z"] }))],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.connections.get("c1"),
            Some(&Some(json!({ "repositories": [] })))
        );
        assert!(ee::granular_access::denies_everything(
            sel.connections.get("c1").and_then(|p| p.as_ref())
        ));
    }

    #[test]
    fn an_org_boundary_applies_to_a_workspace_only_connection() {
        // The connection is granted purely at workspace level; the org never
        // grants it, but its boundary still bounds it.
        let rules = v2_scoped(
            vec![org_wide("c1", json!({ "folders": ["/clients"] }))],
            vec![conn_allow("a1", "c1", json!(null))],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.connections.get("c1"),
            Some(&Some(json!({ "folders": ["/clients"] })))
        );
    }

    #[test]
    fn nested_folder_scopes_compose_to_the_narrower_one() {
        // The org bounds a subtree, the workspace selects its parent: the overlap
        // is the subtree, NOT nothing.
        let rules = v2_scoped(
            vec![org_wide("c1", json!({ "folders": ["/clients/acme"] }))],
            vec![conn_allow("a1", "c1", json!({ "folders": ["/clients"] }))],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.connections.get("c1"),
            Some(&Some(json!({ "folders": ["/clients/acme"] })))
        );
    }

    #[test]
    fn a_plain_org_attach_cannot_evict_an_org_wide_boundary() {
        // Two unrelated org rows for the same connection: an org-wide boundary
        // and this agent's own plain attach (no policy). The plain row sorts
        // later, and under last-match-wins it would erase the boundary — making
        // the effective scope depend on the order of unrelated rules.
        let rules = v2_scoped(
            vec![
                org_wide("c1", json!({ "repositories": ["org/a"] })),
                conn_allow("a1", "c1", json!(null)),
            ],
            vec![],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.connections.get("c1"),
            Some(&Some(json!({ "repositories": ["org/a"] })))
        );
    }

    #[test]
    fn several_org_boundaries_on_one_connection_all_apply() {
        // Each org rule that constrains the connection is a constraint, so the
        // credential may reach only what ALL of them allow.
        let rules = v2_scoped(
            vec![
                org_wide("c1", json!({ "repositories": ["org/a", "org/b"] })),
                org_wide("c1", json!({ "repositories": ["org/b", "org/c"] })),
            ],
            vec![conn_allow("a1", "c1", json!(null))],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.connections.get("c1"),
            Some(&Some(json!({ "repositories": ["org/b"] })))
        );
    }

    #[test]
    fn a_boundary_inherited_through_a_group_binds_this_agent() {
        let principals = PrincipalSet {
            user_ids: vec![],
            group_ids: vec!["g1".to_string()],
        };
        let group_rule = row(
            "allow",
            "custom",
            json!([{ "agentId": null, "userId": null, "groupId": "g1" }]),
            json!([{ "kind": "connection", "appConnectionId": "c1" }]),
            Some(json!({ "repositories": ["org/a"] })),
        );
        let rules = v2_scoped(
            vec![group_rule],
            vec![conn_allow("a1", "c1", json!(null))],
            principals,
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.connections.get("c1"),
            Some(&Some(json!({ "repositories": ["org/a"] })))
        );
    }

    #[test]
    fn a_boundary_is_carried_for_connections_this_fold_cannot_see() {
        // A provider-level grant ("all my org's github connections") resolves
        // its connection ids from the database, long after this fold runs — so
        // the boundary cannot be applied here. It must still travel, or the
        // credential those ids produce would go out unbounded while the UI
        // reports it as restricted.
        let rules = v2_scoped(
            vec![org_wide("c1", json!({ "repositories": ["org/a"] }))],
            vec![row(
                "allow",
                "custom",
                agent("a1"),
                json!([{ "kind": "app", "appProvider": "github-app", "appConnectionScope": "organization" }]),
                None,
            )],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        // Nothing named the connection, so it is not in the grant map...
        assert!(sel.connections.is_empty());
        // ...but its boundary rides along for `connect.rs` to apply.
        assert_eq!(
            sel.boundaries.get("c1"),
            Some(&json!({ "repositories": ["org/a"] }))
        );
        assert_eq!(
            sel.app_scopes,
            vec![("github-app".to_string(), "organization".to_string())]
        );
    }

    #[test]
    fn an_org_boundary_for_another_agent_does_not_bind_this_one() {
        let rules = v2_scoped(
            vec![conn_allow("a2", "c1", json!({ "repositories": ["org/a"] }))],
            vec![conn_allow(
                "a1",
                "c1",
                json!({ "repositories": ["proj/b"] }),
            )],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.connections.get("c1"),
            Some(&Some(json!({ "repositories": ["proj/b"] })))
        );
    }

    #[test]
    fn condition_less_org_grant_does_not_shadow_a_workspace_session_policy() {
        // The `is_object()` predicate: jsonb null (the published shape of an
        // ordinary org grant) is NOT a policy and must not win the merge —
        // `is_some()` here would unrestrict every workspace policy whose
        // connection any org rule also grants.
        let rules = v2_scoped(
            vec![conn_allow("a1", "c1", json!(null))],
            vec![conn_allow("a1", "c1", json!({ "folders": ["/clients"] }))],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.connections.get("c1"),
            Some(&Some(json!({ "folders": ["/clients"] })))
        );
    }

    #[test]
    fn behavioral_array_conditions_on_an_org_rule_do_not_shadow_a_workspace_policy() {
        // Behavioral conditions are arrays; the guards no-op on them, so
        // letting one win the merge would disable a real workspace restriction.
        let rules = v2_scoped(
            vec![conn_allow(
                "a1",
                "c1",
                json!([{ "type": "body_contains", "value": "x" }]),
            )],
            vec![conn_allow(
                "a1",
                "c1",
                json!({ "repositories": ["proj/b"] }),
            )],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.connections.get("c1"),
            Some(&Some(json!({ "repositories": ["proj/b"] })))
        );
    }

    #[test]
    fn org_only_entries_are_copied_as_is() {
        let rules = v2_scoped(
            vec![
                conn_allow("a1", "c_restricted", json!({ "repositories": ["org/a"] })),
                conn_allow("a1", "c_plain", json!(null)),
            ],
            vec![],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(
            sel.connections.get("c_restricted"),
            Some(&Some(json!({ "repositories": ["org/a"] })))
        );
        assert_eq!(sel.connections.get("c_plain"), Some(&Some(json!(null))));
    }

    #[test]
    fn within_one_scope_the_last_matching_row_still_wins() {
        // The WITHIN-scope law, unchanged and now pinned: a later condition-less
        // row clears an earlier policy — which is exactly why the grants
        // compiler carries conditions on EVERY allow row of a stack.
        let rules = v2(
            vec![
                conn_allow("a1", "c1", json!({ "repositories": ["proj/a"] })),
                conn_allow("a1", "c1", json!(null)),
            ],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert_eq!(sel.connections.get("c1"), Some(&Some(json!(null))));
    }

    #[test]
    fn foreign_group_not_in_principal_set_is_ignored() {
        // A rule targeting a group the agent does NOT inherit must not match.
        let rules = v2(
            vec![row(
                "allow",
                "custom",
                json!([{ "agentId": null, "userId": null, "groupId": "g_other" }]),
                json!([{ "kind": "secret", "secretId": "s_x" }]),
                None,
            )],
            PrincipalSet::default(),
        );
        let sel = derive_inject_selection(&rules, "a1");
        assert!(sel.secret_ids.is_empty());
    }
}
