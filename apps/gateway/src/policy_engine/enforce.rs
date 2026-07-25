//! The OSS enforce seam: load the published project rules at connection
//! resolution and decide requests with the first-match core, producing the
//! `policy::PolicyDecision` the forward/websocket act-path understands. The engine
//! is authoritative — an empty rule set (a load error, or an unmigrated project
//! with no Default Rule) decides `Allow`; there is no fallback.
//!
//! HIGH PERFORMANCE: rules load ONCE at connection resolution (cached ~60s
//! with the rest of the connect state); the per-request decision path never
//! touches the DB.

use anyhow::Context;
use sqlx::PgPool;

use crate::cache::CacheStore;
use crate::db::{
    find_connection_providers, find_published_policy_rules_v2_by_project, find_secret_hosts,
    AvailableApps, ConnectionProviders, PolicyRuleV2Row, PolicyV2Rules, SecretHosts,
};
use crate::gateway::{strip_port, ProxyContext};
use crate::policy::{check_rate_limit, MatchedRule, PolicyDecision};

use super::assemble::assemble;
use super::evaluate::evaluate_outcome;
use super::types::{Action, Outcome, Request, Rule};

/// `false` always: OSS's `condition_match` arm cannot buffer bodies and never
/// evaluates conditions (they match vacuously), so there is nothing to buffer for.
pub(crate) fn needs_body_buffer(_v2: &PolicyV2Rules) -> bool {
    false
}

/// Equipment rows are excluded: they are injection-only (dropped by the
/// assembler), so their secret/connection targets never need host/provider
/// resolution — mirroring the EE loader's lazy skip, which keeps the common
/// selective-agent connect resolution free of the two extra queries.
fn has_target_kind(rows: &[PolicyRuleV2Row], kind: &str) -> bool {
    rows.iter()
        .filter(|r| r.source != "equipment")
        .any(|r| r.targets.0.iter().any(|t| t.kind == kind))
}

/// Load the published project rules at resolution time — cached with
/// `ConnectResponse`, off the per-request hot path. Secret hosts and connection
/// providers resolve lazily, only when some loaded rule needs them. Any load error
/// PROPAGATES: the caller refuses the CONNECT rather than caching a policy-free
/// (allow-everything, inject-nothing) state for the ~60s cache cycle.
pub(crate) async fn load_connect_v2(
    pool: &PgPool,
    org_id: &str,
    project_id: &str,
    _agent_id: &str,
) -> anyhow::Result<PolicyV2Rules> {
    let project = find_published_policy_rules_v2_by_project(pool, project_id)
        .await
        .context("policy v2: project load failed at resolution")?;
    let secret_hosts = if has_target_kind(&project, "secret") {
        find_secret_hosts(pool, org_id, project_id)
            .await
            .context("policy v2: secret-host resolution failed at resolution")?
    } else {
        SecretHosts::default()
    };
    let connection_providers = if has_target_kind(&project, "connection") {
        find_connection_providers(pool, org_id, project_id)
            .await
            .context("policy v2: connection-provider resolution failed at resolution")?
    } else {
        ConnectionProviders::default()
    };
    Ok(PolicyV2Rules {
        project,
        secret_hosts,
        connection_providers,
        ..PolicyV2Rules::default()
    })
}

/// "All apps available" always: app availability is a OneCLI Cloud capability;
/// the shared pre-check stays structurally inert here.
pub(crate) async fn load_available_apps(
    _pool: &PgPool,
    _org_id: &str,
    _project_id: &str,
) -> AvailableApps {
    AvailableApps::default()
}

/// Map the winning rule to a `PolicyDecision`, running the rate counter
/// (keyed on `logical_id`, stable across republishes).
async fn decision_for_rule(
    rule: &Rule,
    org_id: &str,
    project_id: &str,
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
        if let Some(decision) = check_rate_limit(
            org_id,
            project_id,
            &rule.logical_id,
            &rule.name,
            limit,
            window.secs(),
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

/// Decide via the OSS core over the already-resolved project rules. No DB access.
/// If the identity is somehow incomplete, or the rule set is empty (a load error,
/// or a project with no published policy), the decision is `Allow` — the engine is
/// authoritative, so there is no fallback.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn evaluate(
    proxy_ctx: &ProxyContext,
    host: &str,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    has_injections: bool,
    is_llm_host: bool,
    cache: &dyn CacheStore,
    v2: &PolicyV2Rules,
) -> (PolicyDecision, Option<MatchedRule>) {
    let (Some(org_id), Some(project_id), Some(agent_id)) = (
        proxy_ctx.organization_id.as_deref(),
        proxy_ctx.project_id.as_deref(),
        proxy_ctx.agent_id.as_deref(),
    ) else {
        return (PolicyDecision::Allow, None);
    };
    let agent_token = proxy_ctx.agent_token.as_deref().unwrap_or("");

    let rules = assemble(&v2.project, &v2.secret_hosts, &v2.connection_providers);
    let request = Request {
        host: strip_port(host).to_string(),
        path: path.to_string(),
        method: method.to_string(),
        agent_id: agent_id.to_string(),
        has_injections,
        is_llm_host,
    };

    let matched_of = |rule: &Rule| MatchedRule {
        logical_id: rule.logical_id.clone(),
        name: rule.name.clone(),
        scope: "project".to_string(),
    };
    match evaluate_outcome(&rules, &request, body) {
        Outcome::Rule(rule) => (
            decision_for_rule(rule, org_id, project_id, agent_token, cache).await,
            Some(matched_of(rule)),
        ),
        Outcome::DenyDefault(default_rule) => (
            PolicyDecision::BlockedByDefaultPolicy,
            Some(matched_of(default_rule)),
        ),
        Outcome::Allow => (PolicyDecision::Allow, None),
    }
}
