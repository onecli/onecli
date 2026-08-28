//! The live enforce seam: decide a request against the published `policy_rules_v2`
//! with the first-match engine, producing the `policy::PolicyDecision` the
//! forward/websocket act-path understands.
//!
//! HIGH PERFORMANCE: the rules are loaded ONCE at connection resolution
//! (`load_connect_v2`, cached ~60s with the rest of the connect state), so the
//! per-request decision path **never touches the DB** — it only decodes the
//! already-resolved rows and evaluates.
//!
//! An empty rule set (a resolution-time load error, or an org with no published
//! policy) decides `Allow` — the engine is authoritative, so there is no fallback.

use anyhow::Context;
use sqlx::PgPool;

use super::loaders::{find_direct_user_principals, find_published_policy_rules_v2_by_org};
use crate::cache::CacheStore;
use crate::db::{
    find_connection_providers, find_published_policy_rules_v2_by_workspace, find_secret_hosts,
    AvailableApps, ConnectionProviders, PolicyRuleV2Row, PolicyV2Rules, PrincipalSet, SecretHosts,
};
use crate::gateway::{strip_port, ProxyContext};
use crate::policy::{check_rate_limit, MatchedRule, PolicyDecision};

use super::assemble::assemble_v2;
use super::evaluate::{evaluate_outcome, Outcome};
use super::types::{Action, NewRule, PolicyRequest, RateWindow, Scope};

/// Whether any loaded v2 rule carries a body condition — the caller must buffer
/// the request body so the v2 engine can evaluate it, else a `body contains`
/// condition sees no body and never matches (a block rule would fail OPEN).
/// Vacuously false when the connection has no v2 rules carrying conditions.
pub(crate) fn needs_body_buffer(v2: &PolicyV2Rules) -> bool {
    v2.org.iter().chain(v2.workspace.iter()).any(|r| {
        r.conditions
            .as_ref()
            .and_then(serde_json::Value::as_array)
            .is_some_and(|arr| !arr.is_empty())
    })
}

/// Load the published new-model rules for a connection's org + workspace at
/// resolution time — cached with `ConnectResponse`, off the per-request hot path.
/// Resolution is all-or-nothing: any failed sub-query PROPAGATES, so the caller
/// refuses the CONNECT rather than caching a policy-free state (which would both
/// allow every request and leave a selective agent with no credentials) for the
/// ~60s cache cycle. A partially-resolved policy is never enforced.
///
/// When some loaded rule targets a directory identity (user/group), the
/// workspace's principal set is resolved here too (one extra query, cached with
/// the rules) so the engine can match it DB-free per request; the common
/// agent-only case skips it.
pub(crate) async fn load_connect_v2(
    pool: &PgPool,
    org_id: &str,
    workspace_id: &str,
    entitled: bool,
) -> anyhow::Result<PolicyV2Rules> {
    let org = find_published_policy_rules_v2_by_org(pool, org_id)
        .await
        .context("policy v2: org load failed at resolution")?;
    let workspace = find_published_policy_rules_v2_by_workspace(pool, workspace_id)
        .await
        .context("policy v2: workspace load failed at resolution")?;
    // Resolve the agent's principal set ONLY when a loaded rule targets a
    // non-agent identity — the common agent-only case skips the query, keeping
    // connection resolution light.
    let principals = if has_non_agent_identity(&org, &workspace, entitled) {
        // The GROUP arm of identity targeting is licensed (#51): entitled
        // deployments resolve the full licensed principal set (direct users,
        // members inherited through granted groups, and the groups to match);
        // unlicensed deployments run the free direct-user twin instead, so
        // no group SQL executes, group-bound rules never match — including
        // group-bound BLOCK rules, which therefore stop firing (the decided
        // posture: no EE behavior survives the flag being off; the console
        // marks such rules "Not enforced") — and nothing is inherited through
        // a group. Individual-user targeting stays free.
        if entitled {
            crate::ee::principals::find_principal_set(pool, workspace_id, org_id)
                .await
                .context("policy v2: principal-set resolution failed at resolution")?
        } else {
            let user_ids = find_direct_user_principals(pool, workspace_id, org_id)
                .await
                .context("policy v2: principal-set resolution failed at resolution")?;
            PrincipalSet {
                user_ids,
                group_ids: Vec::new(),
            }
        }
    } else {
        PrincipalSet::default()
    };
    // Resolve the org+workspace custom secrets' host patterns ONLY when a loaded rule
    // has a secret target — the common network/app case skips the query.
    let secret_hosts = if has_secret_target(&org, &workspace) {
        find_secret_hosts(pool, org_id, workspace_id)
            .await
            .context("policy v2: secret-host resolution failed at resolution")?
    } else {
        SecretHosts::default()
    };
    // Resolve the org+workspace connections' providers ONLY when a loaded rule has a
    // connection target — same lazy skip as the secret-hosts arm above.
    let connection_providers = if has_connection_target(&org, &workspace) {
        find_connection_providers(pool, org_id, workspace_id)
            .await
            .context("policy v2: connection-provider resolution failed at resolution")?
    } else {
        ConnectionProviders::default()
    };
    Ok(PolicyV2Rules {
        org,
        workspace,
        principals,
        secret_hosts,
        connection_providers,
    })
}

/// Whether any loaded rule carries a directory identity the deployment can
/// actually match — the signal that the principal set must be resolved.
/// Agent-only and "any" (empty-identity) rules never need it. Unlicensed,
/// group identities don't count either (#51 — group principals are never
/// resolved there), so a rule set whose only directory arm is groups skips
/// the principal query entirely.
fn has_non_agent_identity(
    org: &[PolicyRuleV2Row],
    workspace: &[PolicyRuleV2Row],
    entitled: bool,
) -> bool {
    org.iter().chain(workspace.iter()).any(|r| {
        r.identities
            .0
            .iter()
            .any(|i| i.user_id.is_some() || (entitled && i.group_id.is_some()))
    })
}

/// Whether any loaded (non-equipment) rule has a `secret` target — the signal to
/// resolve the org+workspace secret hosts at connect. `source="equipment"` rows are
/// dropped from the block/allow engine (`assemble_v2`), so their secret targets
/// never need a host for a decision; only a `custom`/`app_permission`/`blocklist`
/// rule with a secret target does. The common network/app-only case skips the query.
fn has_secret_target(org: &[PolicyRuleV2Row], workspace: &[PolicyRuleV2Row]) -> bool {
    org.iter()
        .chain(workspace.iter())
        .filter(|r| r.source != "equipment")
        .any(|r| r.targets.0.iter().any(|t| t.kind == "secret"))
}

/// Whether any loaded (non-equipment) rule has a `connection` target — the signal
/// to resolve the org+workspace connection providers at connect. Equipment rows are
/// the COMMON carrier of connection targets (per-connection injection) and are
/// dropped from the block/allow engine (`assemble_v2`), so they must not trigger
/// the lookup; only a custom rule's connection target needs a provider to decide.
fn has_connection_target(org: &[PolicyRuleV2Row], workspace: &[PolicyRuleV2Row]) -> bool {
    org.iter()
        .chain(workspace.iter())
        .filter(|r| r.source != "equipment")
        .any(|r| r.targets.0.iter().any(|t| t.kind == "connection"))
}

/// Resolve which apps a workspace may connect (step 7), cached with the rest of the
/// connection state so the per-request pre-check is DB-free. "Open" orgs (the
/// default) and any resolution error fail OPEN (all apps available) — availability
/// is a provisioning gate (policy still governs use), so over-blocking would
/// needlessly cut legitimate app traffic (and the LLM/un-managed carve already
/// spares raw + LLM hosts regardless).
pub(crate) async fn load_available_apps(
    pool: &PgPool,
    org_id: &str,
    workspace_id: &str,
    entitled: bool,
) -> AvailableApps {
    // The availability allowlist (#29) is licensed: unlicensed deployments are
    // always "open" — the default, unrestricted state — and skip both queries
    // (the licensed loader in `crate::ee::principals` is never reached).
    if !entitled {
        return AvailableApps::default();
    }
    crate::ee::principals::load_available_apps(pool, org_id, workspace_id).await
}

/// Map the winning rule to a `PolicyDecision`, running the rate counter for a
/// rate-limit match (keyed on `logical_id`, stable across republishes).
async fn decision_for_rule(
    rule: &NewRule,
    org_id: &str,
    workspace_id: &str,
    agent_token: &str,
    cache: &dyn CacheStore,
) -> PolicyDecision {
    if rule.action == Action::Block {
        return PolicyDecision::Blocked {
            rule_name: rule.name.clone(),
        };
    }
    if rule.require_approval {
        return PolicyDecision::ManualApproval {
            rule_id: rule.id.clone(),
        };
    }
    if let (Some(limit), Some(window)) = (rule.rate_limit, rule.rate_limit_window) {
        let window_secs = match window {
            RateWindow::Minute => 60,
            RateWindow::Hour => 3600,
            RateWindow::Day => 86400,
        };
        if let Some(decision) = check_rate_limit(
            org_id,
            workspace_id,
            &rule.logical_id,
            &rule.name,
            limit,
            window_secs,
            agent_token,
            cache,
        )
        .await
        {
            return decision;
        }
    }
    PolicyDecision::Allow
}

/// Decide via the first-match engine over the already-resolved v2 rules. No DB
/// access — the rules were loaded at resolution. `host` is the original
/// (pre-rewrite) rule-match host, stripped here as defense-in-depth. The decision
/// comes back WITH the matched rule (rule- or default-decided; `None` for a plain
/// allow) so telemetry can attribute it.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn evaluate(
    proxy_ctx: &ProxyContext,
    host: &str,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    has_injections: bool,
    is_llm_host: bool,
    winning_connection_id: Option<&str>,
    cache: &dyn CacheStore,
    v2: &PolicyV2Rules,
) -> (PolicyDecision, Option<MatchedRule>) {
    // The full identity is resolved at connect (before this runs). If it's somehow
    // absent, no policy can be scoped → treat as unmanaged (allow), never a silent
    // block. An empty rule set (e.g. a resolution-time load error left `v2` empty)
    // falls through `evaluate_outcome` to `Allow`; the ~60s cache then refreshes.
    let (Some(org_id), Some(workspace_id), Some(agent_id)) = (
        proxy_ctx.organization_id.as_deref(),
        proxy_ctx.workspace_id.as_deref(),
        proxy_ctx.agent_id.as_deref(),
    ) else {
        return (PolicyDecision::Allow, None);
    };
    let agent_token = proxy_ctx.agent_token.as_str();

    let rules = assemble_v2(
        &v2.org,
        &v2.workspace,
        &v2.secret_hosts,
        &v2.connection_providers,
    );

    let request = PolicyRequest {
        host: strip_port(host).to_string(),
        path: path.to_string(),
        method: method.to_string(),
        agent_id: agent_id.to_string(),
        user_ids: v2.principals.user_ids.clone(),
        group_ids: v2.principals.group_ids.clone(),
        has_injections,
        is_llm_host,
        winning_connection_id: winning_connection_id.map(str::to_string),
    };

    let matched_of = |rule: &NewRule| MatchedRule {
        logical_id: rule.logical_id.clone(),
        name: rule.name.clone(),
        scope: match rule.scope {
            Scope::Organization => "organization".to_string(),
            Scope::Workspace => "workspace".to_string(),
        },
    };
    match evaluate_outcome(&rules, &request, body) {
        Outcome::Rule(rule) => (
            decision_for_rule(rule, org_id, workspace_id, agent_token, cache).await,
            Some(matched_of(rule)),
        ),
        Outcome::DenyDefault(default_rule) => (
            PolicyDecision::BlockedByDefaultPolicy,
            default_rule.map(matched_of),
        ),
        Outcome::Allow => (PolicyDecision::Allow, None),
    }
}

#[cfg(test)]
mod entitlement_tests {
    use super::*;
    use serde_json::json;
    use sqlx::types::Json;

    fn row(identities: serde_json::Value) -> PolicyRuleV2Row {
        PolicyRuleV2Row {
            id: "r1".to_string(),
            logical_id: "lr1".to_string(),
            name: "rule".to_string(),
            source: "custom".to_string(),
            priority: 3,
            is_default: false,
            action: "block".to_string(),
            rate_limit: None,
            rate_limit_window: None,
            require_approval: false,
            conditions: None,
            identities: Json(serde_json::from_value(identities).unwrap_or_default()),
            targets: Json(Vec::new()),
        }
    }

    // #51: which identity mixes require the principal-set query, per
    // entitlement. Unlicensed, a rule set whose only directory arm is GROUPS
    // must skip the query entirely (the principals would be cleared anyway);
    // USER identities keep it — individual-user targeting is free.
    #[test]
    fn principal_query_signal_is_entitlement_aware() {
        let agent_only = [row(
            json!([{ "agentId": "a1", "userId": null, "groupId": null }]),
        )];
        let user = [row(
            json!([{ "agentId": null, "userId": "u1", "groupId": null }]),
        )];
        let group = [row(
            json!([{ "agentId": null, "userId": null, "groupId": "g1" }]),
        )];

        for entitled in [true, false] {
            assert!(!has_non_agent_identity(&agent_only, &[], entitled));
            assert!(has_non_agent_identity(&user, &[], entitled));
            assert!(has_non_agent_identity(&[], &user, entitled));
        }
        assert!(has_non_agent_identity(&group, &[], true));
        assert!(!has_non_agent_identity(&group, &[], false));
        assert!(!has_non_agent_identity(&[], &group, false));
    }
}
