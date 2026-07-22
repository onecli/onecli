//! The OSS enforce seam: load the published project rules at connection
//! resolution and decide requests with the first-match core, producing the
//! `policy::PolicyDecision` the forward/websocket act-path understands.
//!
//! Release-as-cutover: `POLICY_ENFORCE_V2` defaults ON here (unset = enforce;
//! `"0"`/`"false"` is the operator kill-switch), and the per-PROJECT enable
//! signal is data-driven — v2 decides for a project only once its active
//! published generation contains its Default Rule (the boot migrator writes
//! rules + equipment + default in one atomic generation). Anything unmigrated
//! returns `None` and the legacy `policy::evaluate` decides, exactly as today.
//! The stronger is-default predicate (vs merely non-empty) is the fail-open
//! guard: a generation missing its default would otherwise read "no default ⇒
//! allow" and silently open a deny-mode instance.
//!
//! HIGH PERFORMANCE: rules load ONCE at connection resolution (cached ~60s
//! with the rest of the connect state); the per-request decision path never
//! touches the DB.

use std::sync::OnceLock;

use sqlx::PgPool;
use tracing::warn;

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

/// `POLICY_ENFORCE_V2`: an explicit value always wins ("1"/"true" on, anything
/// else off — the kill-switch); unset defaults ON (the OSS release is the
/// cutover). Read once (process-static).
fn enforce_v2_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(
        || match std::env::var("POLICY_ENFORCE_V2").ok().as_deref() {
            Some("1") | Some("true") => true,
            Some(_) => false,
            None => true,
        },
    )
}

/// `false` always: OSS's `condition_match` arm cannot buffer bodies and never
/// evaluates conditions (they match vacuously, exactly like the legacy OSS
/// gateway), so there is nothing to buffer for.
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
/// `ConnectResponse`, off the per-request hot path. Secret hosts and
/// connection providers resolve lazily, only when some loaded rule needs them.
/// Any load error → the default bundle → the legacy path decides for the ~60s
/// cache cycle (fail-safe, all-or-nothing).
pub(crate) async fn load_connect_v2(
    pool: &PgPool,
    org_id: &str,
    project_id: &str,
    _agent_id: &str,
) -> PolicyV2Rules {
    if !enforce_v2_enabled() {
        return PolicyV2Rules::default();
    }
    let project = match find_published_policy_rules_v2_by_project(pool, project_id).await {
        Ok(rows) => rows,
        Err(e) => {
            warn!(error = %e, "policy v2: project load failed at resolution, reverting to legacy");
            return PolicyV2Rules::default();
        }
    };
    let secret_hosts = if has_target_kind(&project, "secret") {
        match find_secret_hosts(pool, org_id, project_id).await {
            Ok(hosts) => hosts,
            Err(e) => {
                warn!(error = %e, "policy v2: secret-host resolution failed, reverting to legacy");
                return PolicyV2Rules::default();
            }
        }
    } else {
        SecretHosts::default()
    };
    let connection_providers = if has_target_kind(&project, "connection") {
        match find_connection_providers(pool, org_id, project_id).await {
            Ok(providers) => providers,
            Err(e) => {
                warn!(error = %e, "policy v2: connection-provider resolution failed, reverting to legacy");
                return PolicyV2Rules::default();
            }
        }
    } else {
        ConnectionProviders::default()
    };
    PolicyV2Rules {
        project,
        secret_hosts,
        connection_providers,
        ..PolicyV2Rules::default()
    }
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

/// No-op: the shadow comparator is an EE diagnostic.
#[allow(clippy::too_many_arguments)]
pub(crate) fn observe(
    _proxy_ctx: &ProxyContext,
    _host: &str,
    _method: &str,
    _path: &str,
    _body: Option<&[u8]>,
    _has_injections: bool,
    _is_llm_host: bool,
    _policy_mode: &str,
    _pool: &PgPool,
) {
}

/// Map the winning rule to a `PolicyDecision`, running the shared rate counter
/// (keyed on `logical_id`, so v2 and legacy count against the same store).
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

/// Decide via the OSS core over the already-resolved project rules, or `None`
/// to revert to the legacy path (kill-switch, project not yet cut over,
/// incomplete identity). No DB access.
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
) -> Option<(PolicyDecision, Option<MatchedRule>)> {
    // Instant kill-switch: re-checked on the decision path too, so a cached
    // `ConnectResponse` can't keep v2 authoritative after the flag flips off.
    if !enforce_v2_enabled() {
        return None;
    }
    // The per-project cutover signal: the published generation must contain
    // the Default Rule (see the module doc for why non-empty is not enough).
    if !v2.project.iter().any(|r| r.is_default) {
        return None;
    }
    let (Some(org_id), Some(project_id), Some(agent_id)) = (
        proxy_ctx.organization_id.as_deref(),
        proxy_ctx.project_id.as_deref(),
        proxy_ctx.agent_id.as_deref(),
    ) else {
        return None;
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
    let (decision, matched) = match evaluate_outcome(&rules, &request, body) {
        Outcome::Rule(rule) => (
            decision_for_rule(rule, org_id, project_id, agent_token, cache).await,
            Some(matched_of(rule)),
        ),
        Outcome::DenyDefault(default_rule) => (
            PolicyDecision::BlockedByDefaultPolicy,
            Some(matched_of(default_rule)),
        ),
        Outcome::Allow => (PolicyDecision::Allow, None),
    };
    Some((decision, matched))
}
