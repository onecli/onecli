//! Policy resolution and caching for CONNECT decisions.
//!
//! Resolves what to do when the gateway receives a CONNECT request by querying
//! the database directly via SQLx. Responses are cached per (agent_token, host)
//! with a configurable TTL.

use std::borrow::Cow;
#[cfg(test)]
use std::sync::Arc;

use tracing::{debug, warn};

use cache::CacheStore;
use inject::secret_inject;
use inject::{Injection, InjectionRule};

/// How long to cache resolved connect responses before re-checking.
const CACHE_TTL_SECS: u64 = 60;

/// Header name for per-request app connection disambiguation (request).
pub const CONNECTION_ID_HEADER: &str = "x-onecli-connection-id";
/// Header name for listing available connections (response).
pub const CONNECTIONS_HEADER: &str = "x-onecli-connections";

/// Which ORG/WORKSPACE credential pool a connecting agent draws from. Since
/// attach-model step 7 the v2 selection IS the whole story: every agent is
/// rule-selected (the legacy `agents.secret_mode` column is dropped).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectionPool {
    /// A rule-driven selection: the fenced pool narrowed to what the agent's
    /// v2 allow rules name.
    RuleSelected,
    /// No selection: nothing from the org/workspace pool is injected. Since
    /// step 10 the old per-agent grant tables are unread, and since step 7
    /// there is no all-mode fallback — an empty selection injects NOTHING,
    /// or a deliberately restricted agent would silently receive every
    /// org/workspace credential.
    Empty,
}

/// The pool for the SECRET side: rule-selected when the agent's rules name
/// secret ids and/or whole levels.
pub fn secret_pool(selection: &db::InjectSelection) -> InjectionPool {
    if selection.secret_ids.is_empty() && selection.secret_scopes.is_empty() {
        return InjectionPool::Empty;
    }
    InjectionPool::RuleSelected
}

/// The pool for the APP-CONNECTION side: the symmetric rule, over named
/// connection ids and/or (provider, level) scopes.
pub fn connection_pool(selection: &db::InjectSelection) -> InjectionPool {
    if selection.connections.is_empty() && selection.app_scopes.is_empty() {
        return InjectionPool::Empty;
    }
    InjectionPool::RuleSelected
}

/// Map an org's billing `subscription_status` to the plan label the gateway
/// enforces integration-call quotas against. Only an explicitly free (or unset)
/// status maps to `"free"`; every other named plan passes through unchanged, so
/// a new paid tier (e.g. "scale") is never silently throttled as the free tier.
/// The quota itself lives in the EE hooks; this only decides which label to pass.
pub fn plan_for_subscription_status(status: &str) -> &str {
    match status {
        "" | "free" => "free",
        other => other,
    }
}

// ── Data types ──────────────────────────────────────────────────────────

/// Result of policy resolution for a CONNECT request.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ConnectResponse {
    pub intercept: bool,
    pub injection_rules: Vec<InjectionRule>,
    #[serde(default)]
    pub app_connections: Vec<db::AppConnectionRow>,
    pub workspace_id: Option<String>,
    pub organization_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub agent_identifier: Option<String>,
    /// True when the workspace has credentials (secrets or app connections) for
    /// this host but the agent can't access them (selective mode). Used to show
    /// a more helpful error ("grant access") instead of "connect the app".
    #[serde(default)]
    pub access_restricted: bool,
    /// Normalized plan name for quota enforcement ("free", "pro", "team",
    /// "enterprise").
    #[serde(default)]
    pub plan: String,
    /// Cloud-only: spend budgets governing the effective credential for this
    /// host (0/1 in practice — the response is per-host).
    #[serde(default)]
    pub budget_bindings: Vec<ee::budget::BudgetBinding>,
    /// Cloud-only: the published new-model policy rules for this connection (org
    /// and workspace scopes), loaded here (cached ~60s with the rest of this
    /// response) so the per-request decision path is DB-free. Empty when
    /// the engine is off, or before the org is backfilled.
    #[serde(default)]
    pub policy_rules_v2: db::PolicyV2Rules,
    /// Cloud-only: the apps this connection's workspace may reach (step 7), resolved
    /// here (cached ~60s with the rest of this response) so the per-request app
    /// pre-check is DB-free. Unrestricted (every app available) in OSS, when the
    /// org's availability mode is "open", or when enforcement is off.
    #[serde(default)]
    pub available_apps: db::AvailableApps,
}

/// Result of per-request app connection resolution.
pub enum AppConnectionResult {
    /// Injection rules resolved from a single connection.
    Rules {
        rules: Vec<InjectionRule>,
        /// Token expiry (UNIX timestamp) from the resolved app connection, if known.
        token_expires_at: Option<i64>,
        /// Rewritten upstream host (e.g., Datadog us5 → api.us5.datadoghq.com).
        rewrite_host: Option<String>,
        /// Display label of the connection (e.g., email address for OAuth accounts).
        connection_label: Option<String>,
        /// Provider-specific request finalizer (e.g., SigV4 vs AssumeRole).
        finalizer: Option<apps::RequestFinalizer>,
        /// Provider-specific body transform (e.g., commit trailer injection).
        body_transform: Option<apps::BodyTransform>,
        /// Provider name of the resolved connection (e.g., "github-app", "datadog").
        provider: String,
        /// Per-agent granular-access policy of THIS connection — the one that
        /// won injection. Carried here (rather than re-derived by a provider
        /// scan) so request-level enforcement applies the correct policy even
        /// when an agent has several same-provider connections.
        session_policy: Option<serde_json::Value>,
        /// Id of the connection that won injection for this request; `None`
        /// when no connection serves this path per the catalog (the
        /// non-serving wipe). Follows `session_policy`'s attribution law
        /// exactly — including its catch-all blind spot: rules that
        /// self-select by path at apply time can inject a credential whose id
        /// was wiped here. `Target::Connection` decisions bind to this id.
        connection_id: Option<String>,
        /// Connections whose credential is minted only once the request is
        /// ALLOWED — see [`PendingInjection`]. Their rules are absent from
        /// `rules` until then, so every "are there injections?" test must
        /// consider this too.
        pending: Vec<PendingInjection>,
    },
    /// No app connections available for this provider.
    NoConnections,
    /// Multiple connections exist and no header was provided — agent must pick.
    Ambiguous { connections: Vec<ConnectionChoice> },
    /// Multiple providers match the same request path — agent must pick.
    MultipleProviders { connections: Vec<ConnectionChoice> },
    /// The requested connection ID was not found — return the valid options.
    NotFound { connections: Vec<ConnectionChoice> },
}

/// Whether a session policy asks for a resource-scoped credential — a non-empty
/// object, the same predicate `resolve_access_token` uses to force a scoped
/// mint. (An empty allowlist reaches nothing and is refused before injection,
/// so it never needs a credential at all.)
fn granular_scoping_requested(session_policy: Option<&serde_json::Value>) -> bool {
    session_policy
        .and_then(|sp| sp.as_object())
        .is_some_and(|obj| !obj.is_empty())
}

/// Stamp what each connection may reach: its own selected scope narrowed to
/// the organization's boundary.
///
/// Both halves matter. A grant that NAMES a connection carries its own scope
/// (already composed with the boundary while folding); a PROVIDER-LEVEL grant
/// carries none, and its connections are only known here — this is the first
/// point at which those ids exist, so it is the only place their boundary can
/// be applied. Re-applying a boundary already composed in the fold is a no-op:
/// intersection with a superset returns the same set.
fn stamp_resource_scopes(
    connections: &mut [db::AppConnectionRow],
    selection: &db::InjectSelection,
    entitled: bool,
) {
    for c in connections {
        // Resources (#39) and the org resource boundary (#40) are licensed.
        // Unlicensed, no session policy is ever stamped — this is the single
        // producer (the row SELECTs hard-code NULL), so every per-request
        // granular hook short-circuits on `None` and credentials inject
        // unscoped. That includes the NARROWING kind of policy: with the flag
        // off no EE behavior runs, protective or not (decided posture; the
        // console surfaces affected grants as not enforced).
        c.session_policy = if entitled {
            ee::granular_access::intersect_policies(
                selection.boundaries.get(&c.id),
                selection.connections.get(&c.id).and_then(|p| p.as_ref()),
            )
        } else {
            None
        };
    }
}

/// A connection whose injection rules are built only after the policy allows
/// the request.
///
/// Resource-scoped credentials (a GitHub installation token limited to specific
/// repositories) are minted live from the provider on every request and never
/// persisted. Building them during resolution meant a request the policy was
/// about to refuse still caused a real credential to be created upstream. The
/// selection — which connection wins, its policy, whether it injects at all —
/// needs none of that, so it happens up front and the mint waits.
///
/// Everything here is already-decrypted, request-scoped state; it never leaves
/// the process and is dropped with the request.
#[derive(Debug)]
pub struct PendingInjection {
    pub conn: db::AppConnectionRow,
    pub decrypted_json: String,
    pub hostname: String,
    pub cache_key: String,
    pub workspace_id: String,
}

/// Cached injection result including host rewrite, so cache hits preserve routing.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct CachedAppInjection {
    rules: Vec<InjectionRule>,
    rewrite_host: Option<String>,
    connection_label: Option<String>,
}

/// A single app connection option returned in disambiguation responses.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionChoice {
    pub id: String,
    pub label: Option<String>,
    pub provider: String,
    pub display_name: Option<&'static str>,
}

impl ConnectionChoice {
    pub fn from_row(row: &db::AppConnectionRow) -> Self {
        Self {
            id: row.id.clone(),
            label: row.label.clone(),
            provider: row.provider.clone(),
            display_name: apps::display_name_for_provider(&row.provider),
        }
    }
}

/// Extract the connection ID from request headers.
pub fn extract_connection_id(headers: &hyper::HeaderMap) -> Option<String> {
    headers
        .get(CONNECTION_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

/// Inject the `x-onecli-connections` response header listing available connections.
pub fn inject_connections_header<B>(
    resp: &mut hyper::Response<B>,
    app_connections: &[db::AppConnectionRow],
) {
    if app_connections.is_empty() {
        return;
    }
    let choices: Vec<ConnectionChoice> = app_connections
        .iter()
        .map(ConnectionChoice::from_row)
        .collect();
    if let Ok(json) = serde_json::to_string(&choices) {
        match hyper::header::HeaderValue::from_str(&json) {
            Ok(val) => {
                resp.headers_mut().insert(CONNECTIONS_HEADER, val);
            }
            Err(e) => {
                tracing::debug!(error = %e, "failed to encode connections header");
            }
        }
    }
}

/// Errors from the connect resolution.
#[derive(Debug)]
pub enum ConnectError {
    /// Agent token is invalid (DB lookup found nothing).
    InvalidToken,
    /// An internal error occurred (DB query, decryption, etc.).
    Internal(String),
}

// ── PolicyEngine ───────────────────────────────────────────────────

// The `PolicyEngine` struct lives in `crate::context` (the shared state holds
// it); its resolution logic stays here, in this module's `impl` blocks.
// Re-exported so existing `connect::PolicyEngine` paths hold.
pub use context::PolicyEngine;

/// The CONNECT resolution surface of [`PolicyEngine`].
///
/// The struct itself lives in `context` (the shared state holds it);
/// this crate owns the resolution logic, expressed as an extension trait —
/// an inherent impl on a foreign type is not allowed. `pub(crate)` and
/// implemented only for `PolicyEngine`, so it adds no public API.
#[async_trait::async_trait]
pub trait PolicyEngineExt {
    /// Look up agent by access token.
    async fn find_agent(&self, agent_token: &str) -> Result<db::AgentRow, ConnectError>;

    /// Resolve what to do for an agent + host combination (without caching).
    async fn resolve_uncached(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
    ) -> Result<ConnectResponse, ConnectError>;

    /// Build injection rules from secrets matching this host.
    /// Returns `(rules, budget_bindings)`.
    async fn resolve_secret_injections(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
        selection: &db::InjectSelection,
    ) -> Result<(Vec<InjectionRule>, Vec<ee::budget::BudgetBinding>), ConnectError>;

    /// Produce a secret's plaintext value from its source — the encrypted column
    /// (inline) or a live 1Password reference. Returns `None` (after logging) when
    /// the value can't be produced, so the caller skips the secret exactly as it
    /// always has on a decrypt failure.
    async fn resolve_secret_value(
        &self,
        secret: &db::SecretRow,
        workspace_id: &str,
    ) -> Option<String>;

    /// Fetch app connections matching providers for this host (deferred resolution).
    ///
    /// Returns the raw `AppConnectionRow` values filtered to providers that match
    /// the hostname. Decryption and injection rule building are deferred to
    /// per-request time via [`PolicyEngineExt::resolve_app_injection_for_request`] so that
    /// multi-connection disambiguation can happen with the `x-onecli-connection-id` header.
    async fn resolve_app_connections(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
        selection: &db::InjectSelection,
    ) -> Result<Vec<db::AppConnectionRow>, ConnectError>;

    #[expect(clippy::too_many_arguments)]
    async fn resolve_app_injection_for_request(
        &self,
        app_connections: &[db::AppConnectionRow],
        hostname: &str,
        request_path: Option<&str>,
        connection_id: Option<&str>,
        organization_id: &str,
        workspace_id: &str,
        cache: &dyn CacheStore,
    ) -> Result<AppConnectionResult, ConnectError>;

    /// Resolve injection rules from a single app connection, with caching.
    /// Decrypts credentials, resolves/refreshes the access token, and builds
    /// injection rules. Results are cached per-connection to avoid redundant
    /// decryption on subsequent requests.
    async fn resolve_connection_injections(
        &self,
        conn: &db::AppConnectionRow,
        hostname: &str,
        organization_id: &str,
        workspace_id: &str,
        cache: &dyn CacheStore,
    ) -> Result<AppConnectionResult, ConnectError>;

    /// Materialize a deferred connection's injection rules — the credential
    /// mint the policy decision was allowed to precede. Called once the request
    /// is allowed; `None` means the credential could not be resolved.
    async fn materialize_pending(
        &self,
        pending: &PendingInjection,
        cache: &dyn CacheStore,
    ) -> Option<Vec<InjectionRule>>;

    /// Resolve the credential and build the connection's injection rules, then
    /// cache them. The tail shared by immediate and deferred resolution, so the
    /// two can never drift. `None` = no usable credential.
    async fn build_connection_rules(
        &self,
        conn: &db::AppConnectionRow,
        decrypted_json: &str,
        hostname: &str,
        workspace_id: &str,
        cache_key: &str,
        cache: &dyn CacheStore,
    ) -> Option<(Vec<InjectionRule>, Option<String>, Option<i64>)>;

    /// Check if the workspace or org has any credentials (secrets or app connections) for this
    /// host that the agent can't access. Used to distinguish "not connected" from
    /// "connected but agent lacks access" in selective mode.
    async fn has_available_credentials(&self, agent: &db::AgentRow, hostname: &str) -> bool;

    /// Extract access token from decrypted credentials JSON, refreshing if expired.
    /// Resolves BYOC client credentials from AppConfig if available, falls back to env vars.
    /// On successful refresh, persists the new credentials back to the database.
    /// Extract the access token from decrypted credentials, refreshing if expired.
    /// Returns `(token, expires_at)` — the effective token and its expiry timestamp.
    async fn resolve_access_token(
        &self,
        json: &str,
        provider: &str,
        workspace_id: &str,
        connection_id: &str,
        session_policy: Option<&serde_json::Value>,
    ) -> Option<(String, Option<i64>)>;

    /// Encrypt and persist refreshed credentials back to the database.
    /// Failures are logged but do not prevent the current request from succeeding —
    /// the refreshed token is already available in memory.
    async fn persist_refreshed_credentials(
        &self,
        connection_id: &str,
        provider: &str,
        creds: &serde_json::Value,
    );

    /// Resolve BYOC client credentials for refreshing a connection.
    ///
    /// Prefers the config that *minted* the connection (the provenance link):
    /// its refresh token is bound to that OAuth client, so refresh must reuse it
    /// even when the tier order below would now pick a different row (e.g. an
    /// org-minted connection whose workspace later added its own config). Falls
    /// back to the workspace's own AppConfig row, then the organization-level row
    /// (EE editions only), for connections with no link (env-minted, no-config
    /// methods, or pre-dating the link) *and* for a link that resolves but
    /// yields no usable pair (config disabled, wrong provider, or missing
    /// clientId/clientSecret). The org tier is consulted whenever the workspace
    /// tier yields no usable pair — row absent OR present but missing
    /// clientId/clientSecret — the same completeness semantics as the Node
    /// resolver's workspace → org chain. Returns
    /// `Some((client_id, client_secret))` when a usable pair exists.
    async fn resolve_byoc_credentials(
        &self,
        workspace_id: &str,
        provider: &str,
        connection_id: &str,
    ) -> Option<(String, String)>;

    /// Extract a usable `(client_id, client_secret)` pair from an AppConfig row.
    async fn extract_byoc_pair(&self, config: db::AppConfigRow) -> Option<(String, String)>;

    /// Org-level BYOC fallback: the app config of the workspace's organization.
    /// Org-level app configs are created only through the EE org surface, so on
    /// an OSS deployment there are no org rows and this degrades to `None`.
    async fn find_org_app_config(
        &self,
        workspace_id: &str,
        provider: &str,
    ) -> Option<db::AppConfigRow>;
}

#[async_trait::async_trait]
impl PolicyEngineExt for PolicyEngine {
    /// Look up agent by access token.
    async fn find_agent(&self, agent_token: &str) -> Result<db::AgentRow, ConnectError> {
        db::find_agent_by_token(&self.pool, agent_token)
            .await
            .map_err(db_err)?
            .ok_or(ConnectError::InvalidToken)
    }
    /// Resolve what to do for an agent + host combination (without caching).
    async fn resolve_uncached(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
    ) -> Result<ConnectResponse, ConnectError> {
        // Load the published new-model policy for this connection's scopes FIRST
        // (cached with the rest of ConnectResponse, so the per-request path never
        // touches the DB). Step 8: the inject-selection derives from these rules
        // which specific credentials the agent's rules allow — the connect-time
        // SELECTION that replaces the equipment join for a selective agent.
        //
        // A load failure REFUSES the CONNECT (like every other query here), so the
        // agent retries. Resolving empty instead would be doubly wrong now that
        // the legacy fallback is gone: every request would decide Allow AND a
        // selective agent would get no credentials — both cached for ~60s.
        let policy_rules_v2 = policy_engine::load_connect_v2(
            &self.pool,
            &agent.organization_id,
            &agent.workspace_id,
            common::edition::entitled(),
        )
        .await
        .map_err(db_err)?;
        let inject_selection = policy_engine::derive_inject_selection(&policy_rules_v2, &agent.id);

        let (injection_rules, budget_bindings) = self
            .resolve_secret_injections(agent, hostname, &inject_selection)
            .await?;
        let app_connections = self
            .resolve_app_connections(agent, hostname, &inject_selection)
            .await?;
        // Intercept when this host has a credential to inject. Enforcement does
        // NOT depend on this: `gateway.rs` forces MITM for every authenticated
        // agent, so a block / rate-limit / approval rule on an uncredentialed host
        // is intercepted and enforced regardless. Keeping a rule-derived term here
        // would only suppress the vault fallback (`gateway.rs` runs it when
        // `!intercept`) for hosts some rule happens to name — including rules
        // scoped to a different agent.
        let has_credentials = !injection_rules.is_empty() || !app_connections.is_empty();

        // Check if the workspace has credentials (secrets or app connections) for
        // this host that the agent's grants don't attach — surfaced as an
        // `access_restricted` error pointing at the attach surface instead of a
        // generic credential-not-found.
        let access_restricted =
            injection_rules.is_empty() && self.has_available_credentials(agent, hostname).await;

        let plan = plan_for_subscription_status(&agent.subscription_status).to_string();

        // Licensed (#29): resolve which apps this workspace may connect (step 7),
        // cached here so the per-request pre-check is DB-free. "All available"
        // unlicensed, when the org's availability mode is "open", or when
        // enforcement is off.
        let available_apps = policy_engine::load_available_apps(
            &self.pool,
            &agent.organization_id,
            &agent.workspace_id,
            common::edition::entitled(),
        )
        .await;

        Ok(ConnectResponse {
            intercept: has_credentials || access_restricted,
            injection_rules,
            app_connections,
            workspace_id: Some(agent.workspace_id.clone()),
            organization_id: Some(agent.organization_id.clone()),
            agent_id: Some(agent.id.clone()),
            agent_name: Some(agent.name.clone()),
            agent_identifier: agent.identifier.clone(),
            access_restricted,
            plan,
            budget_bindings,
            policy_rules_v2,
            available_apps,
        })
    }
    /// Build injection rules from secrets matching this host.
    /// Returns `(rules, budget_bindings)`.
    async fn resolve_secret_injections(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
        selection: &db::InjectSelection,
    ) -> Result<(Vec<InjectionRule>, Vec<ee::budget::BudgetBinding>), ConnectError> {
        // The platform trial credit decides eligibility on the UNFILTERED
        // org+workspace pool (an existing-but-restricted LLM key must count as
        // present — see `ee::platform_llm`), so the pool is fetched when
        // either consumer needs it: rule-driven narrowing, or a configured
        // platform key on this host.
        let platform_candidate = ee::platform_llm::configured_for_host(hostname);
        let mut pool_secrets = if matches!(secret_pool(selection), InjectionPool::RuleSelected)
            || platform_candidate
        {
            let (org_result, workspace_result) = tokio::join!(
                db::find_secrets_by_org(&self.pool, &agent.organization_id),
                db::find_secrets_by_workspace(&self.pool, &agent.workspace_id),
            );
            let mut selected = org_result.map_err(db_err)?;
            selected.extend(workspace_result.map_err(db_err)?);
            selected
        } else {
            Vec::new()
        };
        let pool_has_llm =
            platform_candidate && ee::platform_llm::pool_has_llm_credential(&pool_secrets);

        let secrets = match secret_pool(selection) {
            InjectionPool::RuleSelected => {
                // Rule-driven: the agent's allow rules name specific secrets
                // (`secret_ids`) and/or "all secrets at a level"
                // (`secret_scopes`). NARROW the ORG/WORKSPACE-fenced candidate
                // pool to the named ids OR the named levels (a secret's own
                // `scope` — "organization" / "workspace"). The org-fence is on
                // the FETCH, so a rule naming another org's secret can't pull
                // it (the id simply isn't in the pool).
                pool_secrets.retain(|s| {
                    selection.secret_ids.contains(&s.id)
                        || selection.secret_scopes.contains(&s.scope)
                });
                pool_secrets
            }
            // An agent with no rule-driven selection injects nothing: WHICH
            // org/workspace secrets an agent gets comes solely from its v2 allow
            // rules (incl. the frozen equipment rules that mirror its old
            // grants) — the legacy per-agent grant tables are dropped, and
            // there has been no all-mode fallback since step 7.
            InjectionPool::Empty => Vec::new(),
        };

        let matching: Vec<_> = secrets
            .into_iter()
            .filter(|s| {
                // Injection covers every host this secret's credential is valid on —
                // a SUBSET of the set enforcement resolves (`db::find_secret_hosts`),
                // so a policy rule on the secret can never fall short of injection
                // (the OpenAI multi-host bypass class). The subset is the
                // auth.openai.com carve-out: real OAuth logins are forwarded
                // untouched (#490), while enforcement stays wide.
                secret_inject::secret_injects_on_host(
                    &s.type_,
                    &s.host_pattern,
                    s.metadata.as_ref(),
                    hostname,
                )
            })
            .collect();

        let mut rules = Vec::with_capacity(matching.len());
        for secret in &matching {
            // Resolve the value from its source (inline column or live 1Password
            // reference); a failure skips the secret, exactly as a decrypt
            // failure always has.
            let Some(value) = self.resolve_secret_value(secret, &agent.workspace_id).await else {
                continue;
            };

            // OAuth token refresh applies only to inline OpenAI secrets; a
            // 1Password-sourced value is always a raw API key (api-key metadata).
            let is_openai_oauth = secret.value_source != "onepassword"
                && secret.type_ == "openai"
                && secret_inject::is_oauth_mode(secret.metadata.as_ref());

            let effective_value = if is_openai_oauth {
                match secret_inject::refresh_openai_oauth_if_expired(
                    &self.crypto,
                    &self.pool,
                    &value,
                    &secret.id,
                )
                .await
                {
                    Some(refreshed) => refreshed,
                    None => value,
                }
            } else {
                value
            };

            let injections = secret_inject::build_injections(
                &secret.type_,
                &effective_value,
                secret.injection_config.as_ref(),
                secret.metadata.as_ref(),
            );

            rules.push(InjectionRule {
                path_pattern: secret
                    .path_pattern
                    .clone()
                    .unwrap_or_else(|| "*".to_string()),
                injections,
            });
        }

        // Resolve spend budgets governing the effective credential among the
        // host-filtered secrets. Dormant today — nothing produces
        // budget-eligible secrets (see `ee::budget`) — kept for a future
        // budget surface. No-op in OSS.
        let mut budget_bindings = ee::budget::resolve_bindings(
            &self.pool,
            &agent.organization_id,
            &matching,
            common::edition::entitled(),
        )
        .await;

        // Platform trial credit (cloud + licensed): when the org has no LLM
        // credential of its own and this is the Anthropic host, inject the
        // platform's key under the synthesized lifetime budget — enforced and
        // metered by the same engine as any other binding. Rules-empty is a
        // precondition in effect (an own Anthropic key implies pool_has_llm),
        // so the platform key never shadows a user credential.
        if let Some((rule, binding)) = ee::platform_llm::platform_credential(
            &self.pool,
            &agent.organization_id,
            hostname,
            pool_has_llm,
            common::edition::entitled(),
        )
        .await
        {
            rules.push(rule);
            budget_bindings.push(binding);
        }

        Ok((rules, budget_bindings))
    }
    /// Produce a secret's plaintext value from its source — the encrypted column
    /// (inline) or a live 1Password reference. Returns `None` (after logging) when
    /// the value can't be produced, so the caller skips the secret exactly as it
    /// always has on a decrypt failure.
    async fn resolve_secret_value(
        &self,
        secret: &db::SecretRow,
        workspace_id: &str,
    ) -> Option<String> {
        match secret.value_source.as_str() {
            "onepassword" => {
                let Some(op_ref) = secret.op_ref.as_deref() else {
                    warn!(
                        host_pattern = %secret.host_pattern,
                        secret_type = %secret.type_,
                        "skipping 1Password secret: missing op_ref"
                    );
                    return None;
                };
                match self.onepassword.resolve_ref(workspace_id, op_ref).await {
                    Ok(v) => Some(v),
                    Err(e) => {
                        warn!(
                            host_pattern = %secret.host_pattern,
                            secret_type = %secret.type_,
                            error = %e,
                            "skipping secret: 1Password resolution failed"
                        );
                        None
                    }
                }
            }
            _ => {
                let Some(encrypted) = secret.encrypted_value.as_deref() else {
                    warn!(
                        host_pattern = %secret.host_pattern,
                        secret_type = %secret.type_,
                        "skipping secret: inline secret has no stored value"
                    );
                    return None;
                };
                match self.crypto.decrypt(encrypted).await {
                    Ok(v) => Some(v),
                    Err(e) => {
                        warn!(
                            host_pattern = %secret.host_pattern,
                            secret_type = %secret.type_,
                            error = ?e,
                            "skipping secret: decryption failed (wrong key or format mismatch)"
                        );
                        None
                    }
                }
            }
        }
    }
    /// Fetch app connections matching providers for this host (deferred resolution).
    ///
    /// Returns the raw `AppConnectionRow` values filtered to providers that match
    /// the hostname. Decryption and injection rule building are deferred to
    /// per-request time via [`PolicyEngineExt::resolve_app_injection_for_request`] so that
    /// multi-connection disambiguation can happen with the `x-onecli-connection-id` header.
    async fn resolve_app_connections(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
        selection: &db::InjectSelection,
    ) -> Result<Vec<db::AppConnectionRow>, ConnectError> {
        let providers = apps::providers_for_host(hostname);
        if providers.is_empty() {
            debug!(host = %hostname, "app_connections: no provider for host");
            return Ok(vec![]);
        }
        debug!(host = %hostname, providers = ?providers, "app_connections: matched providers");

        let connections = match connection_pool(selection) {
            InjectionPool::RuleSelected => {
                // Rule-driven: the agent's allow rules name SPECIFIC connections
                // (`kind=connection`) and/or ALL connections of a provider at a
                // level (`kind=app` + `connection_scope`). Fetch the
                // ORG/WORKSPACE-fenced pool and keep the connections a rule
                // selects: a named id, or a (provider, scope) match. Attach the
                // scope each one may reach below. Org-fence on the FETCH → a
                // foreign id/scope can't pull a foreign connection.
                let (org_result, workspace_result) = tokio::join!(
                    db::find_app_connections_by_org(&self.pool, &agent.organization_id),
                    db::find_app_connections_by_workspace(&self.pool, &agent.workspace_id),
                );
                let mut merged = org_result.map_err(db_err)?;
                merged.extend(workspace_result.map_err(db_err)?);
                merged.retain(|c| {
                    selection.connections.contains_key(&c.id)
                        || selection
                            .app_scopes
                            .iter()
                            .any(|(provider, scope)| *provider == c.provider && *scope == c.scope)
                });
                // Org-scoped credentials inject on every tier; only the
                // resource-scope stamping stays licensed (#39/#40) —
                // unlicensed, org connections inject UNSCOPED.
                let entitled = common::edition::entitled();
                stamp_resource_scopes(&mut merged, selection, entitled);
                merged
            }
            // An agent with no rule-driven selection reaches no app connections
            // → none injected. As with secrets, WHICH connections an agent gets
            // comes solely from its v2 allow rules — the legacy per-agent
            // grant tables are dropped, and there has been no all-mode
            // fallback since step 7.
            InjectionPool::Empty => Vec::new(),
        };

        let matching: Vec<db::AppConnectionRow> = connections
            .into_iter()
            .filter(|c| providers.contains(&c.provider.as_str()))
            .collect();

        debug!(host = %hostname, count = matching.len(), "app_connections: deferred connections");
        Ok(matching)
    }

    async fn resolve_app_injection_for_request(
        &self,
        app_connections: &[db::AppConnectionRow],
        hostname: &str,
        request_path: Option<&str>,
        connection_id: Option<&str>,
        organization_id: &str,
        workspace_id: &str,
        cache: &dyn CacheStore,
    ) -> Result<AppConnectionResult, ConnectError> {
        if app_connections.is_empty() {
            return Ok(AppConnectionResult::NoConnections);
        }

        // If a specific connection ID is requested, use that one
        if let Some(conn_id) = connection_id {
            let Some(conn) = app_connections.iter().find(|c| c.id == conn_id) else {
                // Connection was removed or access revoked — return the valid options
                return Ok(AppConnectionResult::NotFound {
                    connections: app_connections
                        .iter()
                        .map(ConnectionChoice::from_row)
                        .collect(),
                });
            };
            // A pinned id only decides WHICH account to use — it cannot decide
            // which PROVIDER serves the path. On a path-scoped shared host
            // (www.googleapis.com: Gmail /gmail/*, Calendar /calendar/*,
            // Drive /drive/*) an id naming a different provider than the
            // request path builds rules that self-select to a path this
            // request isn't on, so NOTHING injects and the upstream 401
            // surfaces as a bogus `access_restricted` — a credential the
            // agent HAS looks unattached. When another attached connection
            // does serve this path, ignore the mismatched pin and fall through
            // to path narrowing below.
            let pin_serves = provider_serves_request(&conn.provider, hostname, request_path);
            let another_serves = || {
                app_connections.iter().any(|c| {
                    c.id != conn.id && provider_serves_request(&c.provider, hostname, request_path)
                })
            };
            if pin_serves || !another_serves() {
                return self
                    .resolve_connection_injections(
                        conn,
                        hostname,
                        organization_id,
                        workspace_id,
                        cache,
                    )
                    .await;
            }
            debug!(
                connection_id = %conn.id,
                provider = %conn.provider,
                host = %hostname,
                "pinned connection does not serve this request path; falling back to path narrowing"
            );
        }

        // On path-scoped shared hosts (e.g. www.googleapis.com, where Gmail,
        // Calendar and Drive coexist by path), narrow to the connections whose
        // provider serves THIS request path before the ambiguity check — so two
        // same-provider connections (e.g. two Gmail accounts) don't make
        // Calendar/Drive requests, which are unambiguous by path, falsely
        // ambiguous. Dedicated hosts and no-path cases fall through unchanged.
        let candidates = narrow_connections_by_path(app_connections, hostname, request_path);
        let app_connections: &[db::AppConnectionRow] = &candidates;

        // Single connection — use it directly. Its rules always merge (they
        // self-select by path at apply time), but the winner metadata is
        // dropped when the provider does not serve this request's path — a
        // lone Calendar connection on a `/youtube/` request must not donate
        // its granular policy, finalizer, or host rewrite.
        if app_connections.len() == 1 {
            let conn = &app_connections[0];
            let mut result = self
                .resolve_connection_injections(conn, hostname, organization_id, workspace_id, cache)
                .await?;
            if let AppConnectionResult::Rules {
                provider,
                rewrite_host,
                connection_label,
                finalizer,
                body_transform,
                session_policy,
                connection_id,
                ..
            } = &mut result
            {
                if !provider_serves_request(provider, hostname, request_path) {
                    *rewrite_host = None;
                    *connection_label = None;
                    *finalizer = None;
                    *body_transform = None;
                    *session_policy = None;
                    *connection_id = None;
                }
            }
            return Ok(result);
        }

        // Multiple connections — check for ambiguity per provider
        // Group by provider; if each provider has exactly 1 connection, no ambiguity
        let mut by_provider: std::collections::HashMap<&str, Vec<&db::AppConnectionRow>> =
            std::collections::HashMap::new();
        for conn in app_connections {
            by_provider
                .entry(conn.provider.as_str())
                .or_default()
                .push(conn);
        }

        if by_provider.values().all(|conns| conns.len() == 1) {
            // Check for cross-provider path overlap before resolving
            if let Some(path) = request_path {
                let matching_providers: Vec<&str> = by_provider
                    .keys()
                    .copied()
                    .filter(|provider| {
                        apps::provider_matches_host_and_path(provider, hostname, path)
                    })
                    .collect();

                if matching_providers.len() > 1 {
                    let connections = app_connections
                        .iter()
                        .filter(|c| matching_providers.contains(&c.provider.as_str()))
                        .map(ConnectionChoice::from_row)
                        .collect();
                    return Ok(AppConnectionResult::MultipleProviders { connections });
                }
            }

            // Each provider has exactly one connection — no ambiguity, resolve all
            let mut rules = Vec::new();
            let mut earliest_expires_at: Option<i64> = None;
            let mut resolved_rewrite_host: Option<String> = None;
            let mut resolved_label: Option<String> = None;
            let mut resolved_finalizer: Option<apps::RequestFinalizer> = None;
            let mut resolved_body_transform: Option<apps::BodyTransform> = None;
            let mut resolved_provider: Option<String> = None;
            let mut resolved_session_policy: Option<serde_json::Value> = None;
            let mut resolved_connection_id: Option<String> = None;
            let mut all_pending: Vec<PendingInjection> = Vec::new();
            for conn in app_connections {
                if let AppConnectionResult::Rules {
                    rules: r,
                    token_expires_at,
                    rewrite_host,
                    connection_label,
                    finalizer,
                    body_transform,
                    provider,
                    session_policy,
                    connection_id,
                    pending,
                } = self
                    .resolve_connection_injections(
                        conn,
                        hostname,
                        organization_id,
                        workspace_id,
                        cache,
                    )
                    .await?
                {
                    rules.extend(r);
                    all_pending.extend(pending);
                    // Tie ALL winner metadata to the connection that actually
                    // serves THIS request — not merely the first to yield
                    // rules. A non-serving connection (e.g. a GitHub
                    // connection on a Dropbox request) still returns `Rules`
                    // carrying its own policy/finalizer/rewrite, and adopting
                    // those would mis-apply them to a request it doesn't own.
                    if provider_serves_request(&provider, hostname, request_path) {
                        if rewrite_host.is_some() {
                            resolved_rewrite_host = rewrite_host;
                        }
                        if resolved_label.is_none() {
                            resolved_label = connection_label;
                        }
                        if finalizer.is_some() {
                            resolved_finalizer = finalizer;
                        }
                        if body_transform.is_some() {
                            resolved_body_transform = body_transform;
                        }
                        resolved_session_policy = session_policy;
                        resolved_connection_id = connection_id;
                    }
                    if resolved_provider.is_none() {
                        resolved_provider = Some(provider);
                    }
                    match (earliest_expires_at, token_expires_at) {
                        (None, exp) => earliest_expires_at = exp,
                        (Some(cur), Some(exp)) if exp < cur => earliest_expires_at = Some(exp),
                        _ => {}
                    }
                }
            }
            return Ok(AppConnectionResult::Rules {
                rules,
                token_expires_at: earliest_expires_at,
                rewrite_host: resolved_rewrite_host,
                connection_label: resolved_label,
                finalizer: resolved_finalizer,
                body_transform: resolved_body_transform,
                provider: resolved_provider.unwrap_or_default(),
                session_policy: resolved_session_policy,
                connection_id: resolved_connection_id,
                pending: all_pending,
            });
        }

        // Truly ambiguous — return all connections for the caller to report
        Ok(AppConnectionResult::Ambiguous {
            connections: app_connections
                .iter()
                .map(ConnectionChoice::from_row)
                .collect(),
        })
    }
    /// Resolve injection rules from a single app connection, with caching.
    /// Decrypts credentials, resolves/refreshes the access token, and builds
    /// injection rules. Results are cached per-connection to avoid redundant
    /// decryption on subsequent requests.
    async fn resolve_connection_injections(
        &self,
        conn: &db::AppConnectionRow,
        hostname: &str,
        organization_id: &str,
        workspace_id: &str,
        cache: &dyn CacheStore,
    ) -> Result<AppConnectionResult, ConnectError> {
        let policy_suffix = conn
            .session_policy
            .as_ref()
            .map(|sp| format!(":{sp}"))
            .unwrap_or_default();
        let cache_key = format!(
            "app_injection:{organization_id}:{workspace_id}:{}:{hostname}{policy_suffix}",
            conn.id
        );

        if let Some(cached) = cache.get::<CachedAppInjection>(&cache_key).await {
            // A warm entry already holds the built rules (credential included),
            // so there is nothing left to defer — the provider call this
            // request would have made already happened for an earlier one.
            debug!(connection_id = %conn.id, "app injection: cache hit");
            return Ok(AppConnectionResult::Rules {
                rules: cached.rules,
                token_expires_at: None,
                rewrite_host: cached.rewrite_host,
                connection_label: cached.connection_label,
                finalizer: apps::finalizer_for_provider(&conn.provider),
                body_transform: apps::body_transform_for_provider(&conn.provider),
                provider: conn.provider.clone(),
                session_policy: conn.session_policy.clone(),
                connection_id: Some(conn.id.clone()),
                pending: Vec::new(),
            });
        }

        let Some(ref encrypted_creds) = conn.credentials else {
            return Ok(AppConnectionResult::NoConnections);
        };

        let decrypted_json = match self.crypto.decrypt(encrypted_creds).await {
            Ok(v) => v,
            Err(e) => {
                warn!(
                    connection_id = %conn.id,
                    provider = %conn.provider,
                    error = ?e,
                    "app connection decrypt failed (wrong key or format mismatch)"
                );
                return Ok(AppConnectionResult::NoConnections);
            }
        };

        // Parse credentials once — reused below for the host gate, credential
        // headers/params, and host rewrite.
        let creds: Option<serde_json::Value> = serde_json::from_str(&decrypted_json)
            .map_err(|e| {
                warn!(provider = %conn.provider, error = %e, "failed to parse app connection credentials JSON");
            })
            .ok();

        // For rules with `credential_host_field` (e.g. JFrog's wildcard
        // `*.jfrog.io`), inject ONLY when the request host equals the
        // connection's exact stored host. This runs BEFORE token resolution,
        // rule building, and caching, so a mismatch yields no injection and
        // writes no cache entry — the token can never leak to another tenant.
        if credential_host_mismatch(&conn.provider, creds.as_ref(), hostname) {
            debug!(
                connection_id = %conn.id,
                provider = %conn.provider,
                "credential host mismatch: request host does not match stored host; no injection"
            );
            return Ok(AppConnectionResult::NoConnections);
        }

        // A scope that reaches nothing needs no credential at all — resolving
        // one could only produce access it may not use. Return early WITH the
        // scope, so the request is refused for it (`hooks::refuse_empty_scope`)
        // rather than quietly proceeding uncredentialed, which would read as
        // unmanaged traffic and escape the deny-defaults.
        if ee::granular_access::denies_everything(conn.session_policy.as_ref()) {
            return Ok(AppConnectionResult::Rules {
                rules: Vec::new(),
                token_expires_at: None,
                rewrite_host: None,
                connection_label: conn.label.clone(),
                finalizer: None,
                body_transform: None,
                provider: conn.provider.clone(),
                session_policy: conn.session_policy.clone(),
                connection_id: Some(conn.id.clone()),
                pending: Vec::new(),
            });
        }

        // Defer the credential when the provider mints a RESOURCE-SCOPED one:
        // that is a live provider call, per request, for a credential that is
        // never persisted — so it must not happen for a request the policy is
        // about to refuse. Selection is unaffected: everything the decision
        // needs (which connection wins, its policy, whether it injects) is
        // already known, and `ResolvedRules::injects` preserves `has_injections`.
        //
        // Only this shape defers. An ordinary expired-token refresh is
        // persisted and would be needed by the next allowed request anyway, so
        // deferring it would buy nothing. Session policies are EE grant data,
        // so an OSS deployment never defers.
        // The scoper is keyed by CREDENTIAL type (`github_app`), which lives in
        // the credentials payload — not by provider name (`github-app`), which
        // would silently match nothing and defer nothing.
        let cred_type = creds
            .as_ref()
            .and_then(|c| c.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let needs_token = apps::needs_access_token(&conn.provider);
        if needs_token
            && ee::granular_access::has_token_scoper(cred_type)
            && granular_scoping_requested(conn.session_policy.as_ref())
            && !apps::host_has_intercept_rules(hostname)
        {
            return Ok(AppConnectionResult::Rules {
                rules: Vec::new(),
                token_expires_at: None,
                rewrite_host: creds.and_then(|c| apps::rewrite_host(&conn.provider, &c, hostname)),
                connection_label: conn.label.clone(),
                finalizer: apps::finalizer_for_provider(&conn.provider),
                body_transform: apps::body_transform_for_provider(&conn.provider),
                provider: conn.provider.clone(),
                session_policy: conn.session_policy.clone(),
                connection_id: Some(conn.id.clone()),
                pending: vec![PendingInjection {
                    conn: conn.clone(),
                    decrypted_json,
                    hostname: hostname.to_string(),
                    cache_key,
                    workspace_id: workspace_id.to_string(),
                }],
            });
        }

        let Some((rules, rewrite_host, expires_at)) = self
            .build_connection_rules(
                conn,
                &decrypted_json,
                hostname,
                workspace_id,
                &cache_key,
                cache,
            )
            .await
        else {
            return Ok(AppConnectionResult::NoConnections);
        };

        Ok(AppConnectionResult::Rules {
            rules,
            token_expires_at: expires_at,
            rewrite_host,
            connection_label: conn.label.clone(),
            finalizer: apps::finalizer_for_provider(&conn.provider),
            body_transform: apps::body_transform_for_provider(&conn.provider),
            provider: conn.provider.clone(),
            session_policy: conn.session_policy.clone(),
            connection_id: Some(conn.id.clone()),
            pending: Vec::new(),
        })
    }
    /// Materialize a deferred connection's injection rules — the credential
    /// mint the policy decision was allowed to precede. Called once the request
    /// is allowed; `None` means the credential could not be resolved.
    async fn materialize_pending(
        &self,
        pending: &PendingInjection,
        cache: &dyn CacheStore,
    ) -> Option<Vec<InjectionRule>> {
        self.build_connection_rules(
            &pending.conn,
            &pending.decrypted_json,
            &pending.hostname,
            &pending.workspace_id,
            &pending.cache_key,
            cache,
        )
        .await
        .map(|(rules, _, _)| rules)
    }
    /// Resolve the credential and build the connection's injection rules, then
    /// cache them. The tail shared by immediate and deferred resolution, so the
    /// two can never drift. `None` = no usable credential.
    async fn build_connection_rules(
        &self,
        conn: &db::AppConnectionRow,
        decrypted_json: &str,
        hostname: &str,
        workspace_id: &str,
        cache_key: &str,
        cache: &dyn CacheStore,
    ) -> Option<(Vec<InjectionRule>, Option<String>, Option<i64>)> {
        let creds: Option<serde_json::Value> = serde_json::from_str(decrypted_json).ok();
        let needs_token = apps::needs_access_token(&conn.provider);
        let (token, expires_at) = if needs_token {
            self.resolve_access_token(
                decrypted_json,
                &conn.provider,
                workspace_id,
                &conn.id,
                conn.session_policy.as_ref(),
            )
            .await?
        } else {
            (String::new(), None)
        };

        let mut rules: Vec<InjectionRule> =
            apps::build_app_injection_rules(&conn.provider, hostname, &token)
                .into_iter()
                .map(|(path_pattern, injections)| InjectionRule {
                    path_pattern,
                    injections,
                })
                .collect();

        // For credential-only providers (no auth rules), ensure at least one
        // catch-all rule exists so credential headers/params have somewhere to attach.
        if rules.is_empty()
            && (!apps::credential_headers(&conn.provider).is_empty()
                || !apps::credential_params(&conn.provider).is_empty())
        {
            let capacity = apps::metadata_headers(&conn.provider).len()
                + apps::credential_headers(&conn.provider).len()
                + apps::credential_params(&conn.provider).len();
            rules.push(InjectionRule {
                path_pattern: "*".to_string(),
                injections: Vec::with_capacity(capacity),
            });
        }

        // Inject metadata-driven headers defined in the provider registry
        if let Some(ref metadata) = conn.metadata {
            for mh in apps::metadata_headers(&conn.provider) {
                if let Some(value) = metadata.get(mh.metadata_key).and_then(|v| v.as_str()) {
                    for rule in &mut rules {
                        rule.injections.push(Injection::SetHeader {
                            name: mh.header_name.to_string(),
                            value: value.to_string(),
                        });
                    }
                }
            }
        }

        // Inject credential-driven headers (e.g., DD-API-KEY from credentials.apiKey)
        if let Some(ref creds) = creds {
            for ch in apps::credential_headers(&conn.provider) {
                if let Some(value) = creds.get(ch.credential_field).and_then(|v| v.as_str()) {
                    for rule in &mut rules {
                        rule.injections.push(Injection::SetHeader {
                            name: ch.header_name.to_string(),
                            value: value.to_string(),
                        });
                    }
                }
            }

            // Inject credential-driven query params (e.g., Trello's ?key=...&token=...)
            for cp in apps::credential_params(&conn.provider) {
                if let Some(value) = creds.get(cp.credential_field).and_then(|v| v.as_str()) {
                    for rule in &mut rules {
                        rule.injections.push(Injection::SetParam {
                            name: cp.param_name.to_string(),
                            value: value.to_string(),
                        });
                    }
                }
            }
        }

        let rewrite_host = creds.and_then(|c| apps::rewrite_host(&conn.provider, &c, hostname));

        // Cache with TTL = min(CACHE_TTL, token remaining lifetime).
        // Skip caching if token is already expired — the stale token would cause
        // upstream 401s, and re-resolving gives a chance to refresh.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_secs() as i64;
        let ttl = match expires_at {
            Some(exp) if exp > now => ((exp - now) as u64).min(CACHE_TTL_SECS),
            Some(_) => 0, // expired — don't cache
            None => CACHE_TTL_SECS,
        };
        if ttl > 0 {
            cache
                .set(
                    cache_key,
                    &CachedAppInjection {
                        rules: rules.clone(),
                        rewrite_host: rewrite_host.clone(),
                        connection_label: conn.label.clone(),
                    },
                    ttl,
                )
                .await;
        }

        Some((rules, rewrite_host, expires_at))
    }
    /// Check if the workspace or org has any credentials (secrets or app connections) for this
    /// host that the agent can't access. Used to distinguish "not connected" from
    /// "connected but agent lacks access" in selective mode.
    async fn has_available_credentials(&self, agent: &db::AgentRow, hostname: &str) -> bool {
        // Check 1: workspace or org has manual secrets matching this host.
        // Same predicate as injection (`secret_injects_on_host`), so a host no
        // secret would ever inject on (e.g. auth.openai.com) can't surface as
        // a bogus `access_restricted`.
        match db::find_secrets_by_workspace(&self.pool, &agent.workspace_id).await {
            Ok(secrets) => {
                if secrets.iter().any(|s| {
                    secret_inject::secret_injects_on_host(
                        &s.type_,
                        &s.host_pattern,
                        s.metadata.as_ref(),
                        hostname,
                    )
                }) {
                    return true;
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "has_available_credentials: secrets query failed");
            }
        }

        // Also check org-level secrets
        match db::find_secrets_by_org(&self.pool, &agent.organization_id).await {
            Ok(secrets) => {
                if secrets.iter().any(|s| {
                    secret_inject::secret_injects_on_host(
                        &s.type_,
                        &s.host_pattern,
                        s.metadata.as_ref(),
                        hostname,
                    )
                }) {
                    return true;
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "has_available_credentials: org secrets query failed");
            }
        }

        // Check 2: workspace or org has app connections for this host
        let providers = apps::providers_for_host(hostname);
        if providers.is_empty() {
            return false;
        }

        let has_workspace_conns = match db::find_app_connections_by_workspace(
            &self.pool,
            &agent.workspace_id,
        )
        .await
        {
            Ok(conns) => conns
                .iter()
                .any(|c| providers.contains(&c.provider.as_str())),
            Err(e) => {
                tracing::warn!(error = %e, "has_available_credentials: app connections query failed");
                false
            }
        };
        if has_workspace_conns {
            return true;
        }

        match db::find_app_connections_by_org(&self.pool, &agent.organization_id).await {
            Ok(conns) => conns
                .iter()
                .any(|c| providers.contains(&c.provider.as_str())),
            Err(e) => {
                tracing::warn!(error = %e, "has_available_credentials: org app connections query failed");
                false
            }
        }
    }
    /// Extract access token from decrypted credentials JSON, refreshing if expired.
    /// Resolves BYOC client credentials from AppConfig if available, falls back to env vars.
    /// On successful refresh, persists the new credentials back to the database.
    /// Extract the access token from decrypted credentials, refreshing if expired.
    /// Returns `(token, expires_at)` — the effective token and its expiry timestamp.
    async fn resolve_access_token(
        &self,
        json: &str,
        provider: &str,
        workspace_id: &str,
        connection_id: &str,
        session_policy: Option<&serde_json::Value>,
    ) -> Option<(String, Option<i64>)> {
        let mut creds: serde_json::Value = serde_json::from_str(json)
            .map_err(|e| {
                warn!(provider = %provider, error = %e, "failed to parse access token credentials JSON");
            })
            .ok()?;

        let mut token = creds
            .get("access_token")
            .and_then(|v| v.as_str())
            .map(String::from);

        let mut effective_expires_at = creds.get("expires_at").and_then(|v| v.as_i64());

        // Any non-empty session policy means scoped access is required.
        // Provider-specific interpretation (e.g. GitHub repos) is handled by
        // granular_access::scope_token, not here. Shares its definition with
        // the deferral predicate so the two can never disagree about whether a
        // request needs a freshly minted credential.
        let needs_scoped_token = granular_scoping_requested(session_policy);
        let mut scoped_token_minted = false;
        // Hoisted: the fail-closed check at the end of this function needs it
        // too, and both must read the same key.
        let cred_type = creds
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Refresh when the stored token has expired, or whenever scoped access
        // is required (a scoped credential is minted per request and never
        // persisted). The scoped case must NOT depend on `expires_at` being
        // present: a payload without it would otherwise skip the mint entirely
        // and fall back to the broad stored token.
        {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before UNIX epoch")
                .as_secs() as i64;

            if effective_expires_at.is_some_and(|exp| exp < now) || needs_scoped_token {
                // Try the granular-access token scoper first, then the shared
                // credential types. WHICH one answered matters: only the scoper
                // can have produced a SCOPED credential. The shared fallback
                // mints the ordinary broad one — treating that as scoped would
                // let a policy the scoper declined (an axis it does not
                // recognize, say) pass the fail-closed check below while
                // nothing enforces it.
                let scoped =
                    ee::granular_access::scope_token(&cred_type, &creds, session_policy).await;
                let from_scoper = scoped.is_some();
                let refresh_result = match scoped {
                    Some(r) => Some(r),
                    None => apps::try_refresh_credentials(&cred_type, &creds, session_policy).await,
                };

                if let Some(result) = refresh_result {
                    match result {
                        Ok((new_token, new_expires_at)) => {
                            debug!(provider = %provider, %cred_type, "refreshed credential");
                            token = Some(new_token.clone());
                            effective_expires_at = Some(new_expires_at);

                            if needs_scoped_token {
                                scoped_token_minted = from_scoper;
                                debug!(provider = %provider, "scoped token generated, skipping persist");
                            } else {
                                creds["access_token"] = serde_json::Value::String(new_token);
                                creds["expires_at"] = serde_json::json!(new_expires_at);
                                self.persist_refreshed_credentials(connection_id, provider, &creds)
                                    .await;
                            }
                        }
                        Err(e) => {
                            debug!(provider = %provider, %cred_type, error = ?e, "credential refresh failed");
                        }
                    }
                } else if let Some(refresh_token) =
                    creds.get("refresh_token").and_then(|v| v.as_str())
                {
                    // Authorized user / default: refresh via OAuth refresh_token
                    if let Some(config) = apps::refresh_config(provider) {
                        let byoc = self
                            .resolve_byoc_credentials(workspace_id, provider, connection_id)
                            .await;
                        let (byoc_id, byoc_secret) = match &byoc {
                            Some((id, secret)) => (Some(id.as_str()), Some(secret.as_str())),
                            None => (None, None),
                        };

                        match apps::refresh_access_token(
                            config,
                            refresh_token,
                            byoc_id,
                            byoc_secret,
                        )
                        .await
                        {
                            Ok((new_token, new_expires_at, new_refresh_token)) => {
                                debug!(provider = %provider, "refreshed expired token");
                                token = Some(new_token.clone());
                                effective_expires_at = Some(new_expires_at);

                                creds["access_token"] = serde_json::Value::String(new_token);
                                creds["expires_at"] = serde_json::json!(new_expires_at);
                                if let Some(new_rt) = new_refresh_token {
                                    creds["refresh_token"] = serde_json::Value::String(new_rt);
                                }
                                self.persist_refreshed_credentials(connection_id, provider, &creds)
                                    .await;
                            }
                            Err(e) => {
                                debug!(provider = %provider, error = ?e, "token refresh failed");
                            }
                        }
                    }
                }
            }
        }

        // A restrictive session policy must NEVER be satisfied with the stored,
        // unscoped credential — but only where the credential itself is how the
        // scope is enforced. For a TOKEN-SCOPED provider every failure above
        // merely logs and falls through (a refusal to mint, an errored refresh,
        // credentials with no `expires_at` so no mint was attempted), and
        // returning the broad token would hand the agent exactly the access the
        // policy exists to withhold — so inject nothing instead.
        //
        // Providers enforced at REQUEST level (Dropbox's folder guard) are the
        // opposite case: the plain stored token IS the correct credential and
        // the guard restricts each call. Withholding it there would not tighten
        // anything, it would break granular access altogether.
        //
        // So the question is not "is this provider token-scoped?" but "is there
        // ANY path that will enforce this scope?" — a provider with neither a
        // scoped mint nor a request guard can enforce nothing, and handing it
        // the broad credential would leave the restriction silently dead.
        if needs_scoped_token
            && !scoped_token_minted
            && !ee::granular_access::has_request_guard(provider)
        {
            warn!(
                provider = %provider,
                connection_id = %connection_id,
                "scoped credential required but not minted; withholding the credential"
            );
            return None;
        }

        token.map(|t| (t, effective_expires_at))
    }
    /// Encrypt and persist refreshed credentials back to the database.
    /// Failures are logged but do not prevent the current request from succeeding —
    /// the refreshed token is already available in memory.
    async fn persist_refreshed_credentials(
        &self,
        connection_id: &str,
        provider: &str,
        creds: &serde_json::Value,
    ) {
        let Ok(json) = serde_json::to_string(creds) else {
            debug!(provider = %provider, "failed to serialize refreshed credentials");
            return;
        };
        match self.crypto.encrypt(&json).await {
            Ok(encrypted) => {
                match db::update_app_connection_credentials(&self.pool, connection_id, &encrypted)
                    .await
                {
                    Ok(()) => {
                        debug!(provider = %provider, "persisted refreshed credentials");
                    }
                    Err(e) => {
                        debug!(provider = %provider, error = %e, "failed to persist refreshed credentials");
                    }
                }
            }
            Err(e) => {
                debug!(provider = %provider, error = ?e, "failed to encrypt refreshed credentials");
            }
        }
    }
    /// Resolve BYOC client credentials for refreshing a connection.
    ///
    /// Prefers the config that *minted* the connection (the provenance link):
    /// its refresh token is bound to that OAuth client, so refresh must reuse it
    /// even when the tier order below would now pick a different row (e.g. an
    /// org-minted connection whose workspace later added its own config). Falls
    /// back to the workspace's own AppConfig row, then the organization-level row
    /// (EE editions only), for connections with no link (env-minted, no-config
    /// methods, or pre-dating the link) *and* for a link that resolves but
    /// yields no usable pair (config disabled, wrong provider, or missing
    /// clientId/clientSecret). The org tier is consulted whenever the workspace
    /// tier yields no usable pair — row absent OR present but missing
    /// clientId/clientSecret — the same completeness semantics as the Node
    /// resolver's workspace → org chain. Returns
    /// `Some((client_id, client_secret))` when a usable pair exists.
    async fn resolve_byoc_credentials(
        &self,
        workspace_id: &str,
        provider: &str,
        connection_id: &str,
    ) -> Option<(String, String)> {
        let linked_row = db::find_app_config_by_connection(&self.pool, connection_id, provider)
            .await
            .map_err(|e| warn!(error = %e, "failed to query linked BYOC app config"))
            .ok()
            .flatten();
        if let Some(row) = linked_row {
            if let Some(pair) = self.extract_byoc_pair(row).await {
                return Some(pair);
            }
            debug!(
                connection_id = %connection_id,
                provider = %provider,
                "linked app config yielded no usable BYOC pair; falling back to workspace/org chain"
            );
        }

        let workspace_row = db::find_app_config(&self.pool, workspace_id, provider)
            .await
            .map_err(|e| warn!(error = %e, "failed to query BYOC app config"))
            .ok()
            .flatten();
        if let Some(row) = workspace_row {
            if let Some(pair) = self.extract_byoc_pair(row).await {
                return Some(pair);
            }
        }

        let org_row = self.find_org_app_config(workspace_id, provider).await?;
        self.extract_byoc_pair(org_row).await
    }
    /// Extract a usable `(client_id, client_secret)` pair from an AppConfig row.
    async fn extract_byoc_pair(&self, config: db::AppConfigRow) -> Option<(String, String)> {
        // clientId is in settings (plain JSON)
        let client_id = config
            .settings
            .as_ref()
            .and_then(|s| s.get("clientId"))
            .and_then(|v| v.as_str())
            .map(String::from)?;

        // clientSecret is in credentials (encrypted)
        let encrypted = config.credentials.as_deref()?;
        let decrypted = self
            .crypto
            .decrypt(encrypted)
            .await
            .map_err(|e| warn!(error = %e, "failed to decrypt BYOC credentials"))
            .ok()?;
        let secrets: serde_json::Value = serde_json::from_str(&decrypted)
            .map_err(|e| warn!(error = %e, "failed to parse BYOC credentials JSON"))
            .ok()?;
        let client_secret = secrets
            .get("clientSecret")
            .and_then(|v| v.as_str())
            .map(String::from)?;

        Some((client_id, client_secret))
    }
    /// Org-level BYOC fallback: the app config of the workspace's organization.
    /// Org-level app configs are created only through the EE org surface, so on
    /// an OSS deployment there are no org rows and this degrades to `None`.
    async fn find_org_app_config(
        &self,
        workspace_id: &str,
        provider: &str,
    ) -> Option<db::AppConfigRow> {
        let organization_id = db::find_organization_id_by_workspace(&self.pool, workspace_id)
            .await
            .map_err(|e| warn!(error = %e, "failed to resolve org for BYOC fallback"))
            .ok()
            .flatten()?;
        db::find_app_config_by_org(&self.pool, &organization_id, provider)
            .await
            .map_err(|e| warn!(error = %e, "failed to query org BYOC app config"))
            .ok()
            .flatten()
    }
}

// ── Error helpers ──────────────────────────────────────────────────────

fn db_err(e: anyhow::Error) -> ConnectError {
    ConnectError::Internal(format!("db error: {e:#}"))
}

// ── Cached resolution ───────────────────────────────────────────────────

/// Resolve with caching. Checks the generic `CacheStore` first, then
/// queries the DB if needed. The cache key is namespaced as
/// `connect:{workspace_id}:{agent_token}:{hostname}` so that cache
/// invalidation can target all entries for a workspace by prefix.
pub async fn resolve(
    agent_token: &str,
    hostname: &str,
    policy_engine: &PolicyEngine,
    cache: &dyn CacheStore,
) -> Result<ConnectResponse, ConnectError> {
    // Look up agent first — needed for workspace_id in cache key.
    let agent = policy_engine.find_agent(agent_token).await?;

    let cache_key = format!(
        "connect:{}:{}:{agent_token}:{hostname}",
        agent.organization_id, agent.workspace_id
    );

    if let Some(response) = cache.get::<ConnectResponse>(&cache_key).await {
        debug!(host = %hostname, intercept = response.intercept, "resolve: cache hit");
        return Ok(response);
    }

    debug!(host = %hostname, "resolve: cache miss, querying DB");

    // Query the database (agent already resolved, avoids re-querying)
    let response = policy_engine.resolve_uncached(&agent, hostname).await?;

    cache.set(&cache_key, &response, CACHE_TTL_SECS).await;

    Ok(response)
}

/// Resolve with caching, using a known `workspace_id` to skip the agent DB
/// query on cache hits. Designed for per-request resolution inside MITM
/// tunnels where the agent identity is already known from CONNECT time.
///
/// On cache hit: zero DB queries (just a cache lookup).
/// On cache miss: falls back to full resolution (agent query + DB).
pub async fn resolve_from_cache(
    organization_id: &str,
    workspace_id: &str,
    agent_token: &str,
    hostname: &str,
    policy_engine: &PolicyEngine,
    cache: &dyn CacheStore,
) -> Result<ConnectResponse, ConnectError> {
    let cache_key = format!("connect:{organization_id}:{workspace_id}:{agent_token}:{hostname}");

    if let Some(response) = cache.get::<ConnectResponse>(&cache_key).await {
        return Ok(response);
    }

    debug!(host = %hostname, "resolve_from_cache: cache miss, querying DB");

    let agent = policy_engine.find_agent(agent_token).await?;
    let response = policy_engine.resolve_uncached(&agent, hostname).await?;
    cache.set(&cache_key, &response, CACHE_TTL_SECS).await;

    Ok(response)
}

// ── Connection narrowing ─────────────────────────────────────────────────

/// Narrow app connections to those whose provider serves THIS request path,
/// but only on shared, path-scoped hosts (e.g. `www.googleapis.com`, where
/// Gmail, Calendar and Drive coexist by path prefix).
///
/// Without this, two connections of a single provider (e.g. two Gmail accounts)
/// make *every* path on the shared host ambiguous — including Calendar/Drive
/// requests that are unambiguous by path — forcing an `x-onecli-connection-id`
/// header on requests that need none. Dedicated hosts (`gmail.googleapis.com`,
/// no path prefix) are not path-scoped, so the full set is returned unchanged.
///
/// Returns the full set (borrowed) when there is no request path, the host is
/// not path-scoped, or no connection serves the path — preserving prior
/// behavior in every case except the shared-host mismatch this fixes.
fn narrow_connections_by_path<'a>(
    connections: &'a [db::AppConnectionRow],
    hostname: &str,
    request_path: Option<&str>,
) -> Cow<'a, [db::AppConnectionRow]> {
    // Narrowing can only change the outcome with at least two connections to
    // disambiguate; skip the work — and the clone — for the common 0/1 case.
    if connections.len() <= 1 {
        return Cow::Borrowed(connections);
    }
    let Some(path) = request_path else {
        return Cow::Borrowed(connections);
    };
    if !apps::host_has_path_scoped_providers(hostname) {
        return Cow::Borrowed(connections);
    }
    let narrowed: Vec<db::AppConnectionRow> = connections
        .iter()
        .filter(|c| apps::provider_matches_host_and_path(&c.provider, hostname, path))
        .cloned()
        .collect();
    if narrowed.is_empty() {
        Cow::Borrowed(connections)
    } else {
        Cow::Owned(narrowed)
    }
}

/// True when `provider` serves this request's host+path. Winner metadata
/// (granular policy, finalizer, body transform, host rewrite, label) is
/// adopted only from a serving connection; injection rules need no such
/// gate — they self-select via `path_pattern` at apply time. A missing
/// request path is conservatively non-serving.
fn provider_serves_request(provider: &str, hostname: &str, request_path: Option<&str>) -> bool {
    request_path
        .map(|p| apps::provider_matches_host_and_path(provider, hostname, p))
        .unwrap_or(false)
}

/// Test-only: seed the `app_injection:` cache entry exactly the way
/// `resolve_connection_injections` writes it (struct-typed, so shape drift
/// breaks tests loudly instead of deserializing via defaults).
#[cfg(test)]
#[expect(clippy::too_many_arguments)]
pub async fn seed_app_injection_cache(
    cache: &Arc<dyn CacheStore>,
    organization_id: &str,
    workspace_id: &str,
    conn: &db::AppConnectionRow,
    hostname: &str,
    rules: Vec<InjectionRule>,
    rewrite_host: Option<&str>,
    connection_label: Option<&str>,
) {
    let policy_suffix = conn
        .session_policy
        .as_ref()
        .map(|sp| format!(":{sp}"))
        .unwrap_or_default();
    let key = format!(
        "app_injection:{organization_id}:{workspace_id}:{}:{hostname}{policy_suffix}",
        conn.id
    );
    let entry = CachedAppInjection {
        rules,
        rewrite_host: rewrite_host.map(str::to_string),
        connection_label: connection_label.map(str::to_string),
    };
    cache.set(&key, &entry, 60).await;
}

// ── Host matching ───────────────────────────────────────────────────────

/// Returns `true` when the credential's stored host does not match the
/// request host, meaning injection must be skipped.
///
/// For rules with `credential_host_field` (e.g. JFrog's `*.jfrog.io`),
/// injection is allowed ONLY when the request host equals the stored host.
/// Returns `false` for rules without `credential_host_field` (no check
/// needed) and for rules whose stored host matches the request host.
///
/// The comparison is on the FULL normalized host — never a single DNS label —
/// so `mycompany.jfrog.io` does not match `evil.jfrog.io`.
fn credential_host_mismatch(
    provider: &str,
    creds: Option<&serde_json::Value>,
    hostname: &str,
) -> bool {
    let Some(field) = apps::credential_host_field(provider, hostname) else {
        return false; // not a host-gated rule — injection always allowed
    };
    let stored = creds
        .and_then(|c| c.get(field))
        .and_then(|v| v.as_str())
        .map(apps::normalize_host)
        .unwrap_or_default();
    stored.is_empty() || apps::normalize_host(hostname) != stored
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    async fn new_store() -> std::sync::Arc<dyn cache::CacheStore> {
        cache::in_memory()
    }

    // ── Injection pool (attach-model step 7) ────────────────────────────
    // The v2 selection is the WHOLE story for the ORG/WORKSPACE tiers: the old
    // per-agent grant tables became unread in step 10 and the all-mode merge
    // died in step 7, so there is nothing left to fall back to. The
    // load-bearing property is that an agent with nothing selected draws
    // NOTHING from those tiers — anything else would hand a deliberately
    // restricted agent every credential in the workspace and org.

    fn selection_with_secret(id: &str) -> db::InjectSelection {
        db::InjectSelection {
            secret_ids: std::collections::HashSet::from([id.to_string()]),
            ..Default::default()
        }
    }

    fn selection_with_connection(id: &str) -> db::InjectSelection {
        db::InjectSelection {
            connections: std::collections::HashMap::from([(id.to_string(), None)]),
            ..Default::default()
        }
    }

    #[test]
    fn agent_without_a_selection_injects_nothing() {
        let empty = db::InjectSelection::default();
        assert_eq!(
            secret_pool(&empty),
            InjectionPool::Empty,
            "no secret selection injects nothing from the org/workspace tiers"
        );
        assert_eq!(
            connection_pool(&empty),
            InjectionPool::Empty,
            "no connection selection injects no app connections"
        );
    }

    // ── Plan resolution (subscription_status to quota plan label) ────────
    // The free-tier integration-call quota keys off this label, so a real paid
    // tier must never collapse to "free". Regression guard for the `scale` plan
    // being throttled as free, and for any future tier.
    #[test]
    fn plan_resolution_only_treats_free_as_free() {
        assert_eq!(plan_for_subscription_status("free"), "free");
        assert_eq!(plan_for_subscription_status(""), "free");
        assert_eq!(plan_for_subscription_status("pro"), "pro");
        assert_eq!(plan_for_subscription_status("team"), "team");
        assert_eq!(plan_for_subscription_status("enterprise"), "enterprise");
        assert_eq!(plan_for_subscription_status("scale"), "scale");
        // A future paid tier must pass through, never fall back to "free".
        assert_eq!(plan_for_subscription_status("ultra"), "ultra");
    }

    #[test]
    fn agent_with_a_selection_draws_the_narrowed_pool() {
        assert_eq!(
            secret_pool(&selection_with_secret("sec-1")),
            InjectionPool::RuleSelected
        );
        assert_eq!(
            secret_pool(&db::InjectSelection {
                secret_scopes: vec!["workspace".to_string()],
                ..Default::default()
            }),
            InjectionPool::RuleSelected,
            "a whole-level secret target selects too, not just named ids"
        );
        assert_eq!(
            connection_pool(&selection_with_connection("conn-1")),
            InjectionPool::RuleSelected
        );
        assert_eq!(
            connection_pool(&db::InjectSelection {
                app_scopes: vec![("github".to_string(), "workspace".to_string())],
                ..Default::default()
            }),
            InjectionPool::RuleSelected,
            "a provider+level app target selects too"
        );
    }

    #[tokio::test]
    async fn cache_hit_returns_cached_response() {
        let store = new_store().await;
        let response = ConnectResponse {
            intercept: true,
            injection_rules: vec![],
            app_connections: vec![],
            workspace_id: None,
            organization_id: None,
            agent_id: None,
            agent_name: None,
            agent_identifier: None,
            access_restricted: false,
            plan: "pro".to_string(),
            budget_bindings: vec![],
            policy_rules_v2: db::PolicyV2Rules::default(),
            available_apps: db::AvailableApps::default(),
        };

        store
            .set(
                "connect:acc_123:aoc_token1:api.anthropic.com",
                &response,
                60,
            )
            .await;

        let cached: Option<ConnectResponse> = store
            .get("connect:acc_123:aoc_token1:api.anthropic.com")
            .await;
        assert_eq!(cached, Some(response));
    }

    #[tokio::test]
    async fn cache_miss_returns_none() {
        let store = new_store().await;
        let cached: Option<ConnectResponse> = store.get("connect:missing:host").await;
        assert!(cached.is_none());
    }

    // ── resolve_from_cache ────────────────────────────────────────────

    #[tokio::test]
    async fn resolve_from_cache_hits_with_correct_key() {
        let store = new_store().await;
        let response = ConnectResponse {
            intercept: true,
            injection_rules: vec![InjectionRule {
                path_pattern: "*".to_string(),
                injections: vec![],
            }],
            app_connections: vec![],
            workspace_id: Some("proj_1".to_string()),
            organization_id: Some("org_1".to_string()),
            agent_id: Some("agent_1".to_string()),
            agent_name: Some("Test".to_string()),
            agent_identifier: None,
            access_restricted: false,
            plan: "pro".to_string(),
            budget_bindings: vec![],
            policy_rules_v2: db::PolicyV2Rules::default(),
            available_apps: db::AvailableApps::default(),
        };

        // Pre-populate cache with the key format that resolve() uses
        store
            .set(
                "connect:org_1:proj_1:aoc_token1:api.example.com",
                &response,
                60,
            )
            .await;

        // resolve_from_cache should hit using the same key format.
        // On cache hit it never touches PolicyEngine, so we can't pass one —
        // but we can verify the key is correct by checking the cache directly.
        let cached: Option<ConnectResponse> = store
            .get(&format!(
                "connect:{}:{}:{}:{}",
                "org_1", "proj_1", "aoc_token1", "api.example.com"
            ))
            .await;
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().injection_rules.len(), 1);
    }

    #[tokio::test]
    async fn cache_round_trip_with_access_restricted() {
        let store = new_store().await;
        let response = ConnectResponse {
            intercept: true,
            injection_rules: vec![],
            app_connections: vec![],
            workspace_id: Some("proj_restricted".to_string()),
            organization_id: Some("org_restricted".to_string()),
            agent_id: Some("agent_selective".to_string()),
            agent_name: Some("Selective Agent".to_string()),
            agent_identifier: None,
            access_restricted: true,
            plan: "pro".to_string(),
            budget_bindings: vec![],
            policy_rules_v2: db::PolicyV2Rules::default(),
            available_apps: db::AvailableApps::default(),
        };

        store
            .set(
                "connect:org_restricted:proj_restricted:aoc_t:api.resend.com",
                &response,
                60,
            )
            .await;

        let cached: Option<ConnectResponse> = store
            .get("connect:org_restricted:proj_restricted:aoc_t:api.resend.com")
            .await;
        let cached = cached.expect("should be cached");
        assert!(cached.access_restricted);
        assert_eq!(cached.workspace_id.as_deref(), Some("proj_restricted"));
    }

    // ── credential_host_mismatch ─────────────────────────────────────────

    #[test]
    fn credential_host_mismatch_skipped_for_non_gated_provider() {
        // Rules without credential_host_field are never gated, even if the
        // hostname looks unrelated to any stored credential.
        let creds = serde_json::json!({ "access_token": "t" });
        assert!(!credential_host_mismatch(
            "github",
            Some(&creds),
            "api.github.com"
        ));
        assert!(!credential_host_mismatch("resend", None, "api.resend.com"));
    }

    #[test]
    fn credential_host_mismatch_false_when_hosts_match() {
        let creds = serde_json::json!({
            "access_token": "t",
            "token": "t",
            "subdomain": "mycompany.jfrog.io",
        });
        assert!(!credential_host_mismatch(
            "jfrog-artifactory",
            Some(&creds),
            "mycompany.jfrog.io"
        ));
    }

    #[test]
    fn credential_host_mismatch_false_with_scheme_and_case() {
        // Stored value may be a full URL or differently-cased; both sides are
        // normalized before comparison.
        let creds = serde_json::json!({ "subdomain": "https://MyCompany.JFrog.io/" });
        assert!(!credential_host_mismatch(
            "jfrog-artifactory",
            Some(&creds),
            "mycompany.jfrog.io"
        ));
    }

    #[test]
    fn credential_host_mismatch_other_tenant() {
        // A malicious dependency hitting evil.jfrog.io must NOT receive the
        // token stored for mycompany.jfrog.io.
        let creds = serde_json::json!({ "subdomain": "mycompany.jfrog.io" });
        assert!(credential_host_mismatch(
            "jfrog-artifactory",
            Some(&creds),
            "evil.jfrog.io"
        ));
    }

    #[test]
    fn credential_host_mismatch_snowflake_other_tenant() {
        // Snowflake's PAT is gated on the connection's stored `host` — a
        // request to another tenant's *.snowflakecomputing.com account must
        // NOT receive it, and the matching host must.
        let creds = serde_json::json!({
            "access_token": "pat",
            "host": "myorg-myaccount.snowflakecomputing.com",
        });
        assert!(credential_host_mismatch(
            "snowflake",
            Some(&creds),
            "evil-tenant.snowflakecomputing.com"
        ));
        assert!(!credential_host_mismatch(
            "snowflake",
            Some(&creds),
            "myorg-myaccount.snowflakecomputing.com"
        ));
        // A connection stored without a host field fails closed.
        let no_host = serde_json::json!({ "access_token": "pat" });
        assert!(credential_host_mismatch(
            "snowflake",
            Some(&no_host),
            "myorg-myaccount.snowflakecomputing.com"
        ));
    }

    #[test]
    fn credential_host_mismatch_missing_or_empty_subdomain() {
        // No subdomain field at all.
        let creds = serde_json::json!({ "access_token": "t" });
        assert!(credential_host_mismatch(
            "jfrog-artifactory",
            Some(&creds),
            "mycompany.jfrog.io"
        ));
        // Empty subdomain.
        let empty = serde_json::json!({ "subdomain": "" });
        assert!(credential_host_mismatch(
            "jfrog-artifactory",
            Some(&empty),
            "mycompany.jfrog.io"
        ));
        // No credentials at all.
        assert!(credential_host_mismatch(
            "jfrog-artifactory",
            None,
            "mycompany.jfrog.io"
        ));
    }

    #[test]
    fn credential_host_mismatch_similar_subdomain() {
        // The gate compares the FULL host, so a stored host must not be matched
        // by a similarly-named subdomain on the same suffix.
        let creds = serde_json::json!({ "subdomain": "mycompany.jfrog.io" });
        assert!(credential_host_mismatch(
            "jfrog-artifactory",
            Some(&creds),
            "mycompany-clone.jfrog.io"
        ));
    }

    // ── narrow_connections_by_path ────────────────────────────────────────

    fn conn(id: &str, provider: &str) -> db::AppConnectionRow {
        db::AppConnectionRow {
            id: id.into(),
            provider: provider.into(),
            scope: "workspace".into(),
            credentials: None,
            label: None,
            metadata: None,
            session_policy: None,
        }
    }

    fn ids(conns: &[db::AppConnectionRow]) -> Vec<&str> {
        conns.iter().map(|c| c.id.as_str()).collect()
    }

    // ── serves-path metadata gating (#428) ──────────────────────────────

    fn bearer_rule(pattern: &str, token: &str) -> InjectionRule {
        InjectionRule {
            path_pattern: pattern.to_string(),
            injections: vec![Injection::SetHeader {
                name: "authorization".to_string(),
                value: format!("Bearer {token}"),
            }],
        }
    }

    async fn seed_app_injection(
        cache: &Arc<dyn CacheStore>,
        conn: &db::AppConnectionRow,
        hostname: &str,
        rules: Vec<InjectionRule>,
        rewrite_host: Option<&str>,
        connection_label: Option<&str>,
    ) {
        seed_app_injection_cache(
            cache,
            "o1",
            "p1",
            conn,
            hostname,
            rules,
            rewrite_host,
            connection_label,
        )
        .await;
    }

    #[tokio::test]
    async fn single_connection_metadata_gated_to_serving_path() {
        let engine = PolicyEngine::test_stub();
        let store = new_store().await;
        let mut c = conn("c1", "google-calendar");
        c.session_policy = Some(serde_json::json!({"folders": ["x"]}));
        seed_app_injection(
            &store,
            &c,
            "www.googleapis.com",
            vec![bearer_rule("/calendar/*", "cal")],
            Some("rw.example.com"),
            Some("Cal"),
        )
        .await;

        // Non-serving path (/youtube): rules still returned, metadata dropped.
        let res = engine
            .resolve_app_injection_for_request(
                std::slice::from_ref(&c),
                "www.googleapis.com",
                Some("/youtube/v3/search"),
                None,
                "o1",
                "p1",
                &*store,
            )
            .await
            .unwrap();
        match res {
            AppConnectionResult::Rules {
                rules,
                rewrite_host,
                connection_label,
                finalizer,
                body_transform,
                session_policy,
                connection_id,
                ..
            } => {
                assert_eq!(rules.len(), 1);
                assert!(rewrite_host.is_none());
                assert!(connection_label.is_none());
                assert!(finalizer.is_none());
                assert!(body_transform.is_none());
                assert!(session_policy.is_none());
                assert!(connection_id.is_none(), "winner id follows the wipe law");
            }
            _ => panic!("expected Rules"),
        }

        // Serving path (/calendar): metadata kept.
        let res = engine
            .resolve_app_injection_for_request(
                std::slice::from_ref(&c),
                "www.googleapis.com",
                Some("/calendar/v3/events"),
                None,
                "o1",
                "p1",
                &*store,
            )
            .await
            .unwrap();
        match res {
            AppConnectionResult::Rules {
                rewrite_host,
                connection_label,
                session_policy,
                connection_id,
                ..
            } => {
                assert_eq!(rewrite_host.as_deref(), Some("rw.example.com"));
                assert_eq!(connection_label.as_deref(), Some("Cal"));
                assert!(session_policy.is_some());
                assert_eq!(connection_id.as_deref(), Some("c1"));
            }
            _ => panic!("expected Rules"),
        }
    }

    #[tokio::test]
    async fn explicit_connection_id_keeps_metadata_off_path() {
        let engine = PolicyEngine::test_stub();
        let store = new_store().await;
        let c = conn("c1", "google-calendar");
        seed_app_injection(
            &store,
            &c,
            "www.googleapis.com",
            vec![bearer_rule("/calendar/*", "cal")],
            Some("rw.example.com"),
            Some("Cal"),
        )
        .await;

        // An explicit x-onecli-connection-id is a deliberate override: the
        // serves-path gate does not apply — unless another attached
        // connection actually serves the path (see the fallback test below).
        // Here the pinned connection is the only one, so the pin stands even
        // off-path.
        let res = engine
            .resolve_app_injection_for_request(
                std::slice::from_ref(&c),
                "www.googleapis.com",
                Some("/youtube/v3/search"),
                Some("c1"),
                "o1",
                "p1",
                &*store,
            )
            .await
            .unwrap();
        match res {
            AppConnectionResult::Rules {
                rewrite_host,
                connection_label,
                connection_id,
                ..
            } => {
                assert_eq!(rewrite_host.as_deref(), Some("rw.example.com"));
                assert_eq!(connection_label.as_deref(), Some("Cal"));
                assert_eq!(
                    connection_id.as_deref(),
                    Some("c1"),
                    "an explicit override names the winner even off-path"
                );
            }
            _ => panic!("expected Rules"),
        }
    }

    #[tokio::test]
    async fn mismatched_pin_falls_back_to_the_connection_that_serves_the_path() {
        // A Gmail connection id pinned on a CALENDAR request (the shared
        // www.googleapis.com host). The pin names an account, not a provider:
        // honoring it would build only /gmail/* rules, which self-select away
        // from this path, so nothing injects and Google's 401 surfaces as a
        // bogus `access_restricted`. The Calendar connection serves the path,
        // so it wins instead.
        let engine = PolicyEngine::test_stub();
        let store = new_store().await;
        let cal = conn("c1", "google-calendar");
        let gm = conn("c2", "gmail");
        seed_app_injection(
            &store,
            &cal,
            "www.googleapis.com",
            vec![bearer_rule("/calendar/*", "cal")],
            None,
            Some("Cal"),
        )
        .await;
        seed_app_injection(
            &store,
            &gm,
            "www.googleapis.com",
            vec![bearer_rule("/gmail/*", "gm")],
            None,
            Some("Gm"),
        )
        .await;

        let conns = vec![cal, gm.clone()];
        let res = engine
            .resolve_app_injection_for_request(
                &conns,
                "www.googleapis.com",
                Some("/calendar/v3/calendars/primary/events"),
                Some("c2"),
                "o1",
                "p1",
                &*store,
            )
            .await
            .unwrap();
        match res {
            AppConnectionResult::Rules {
                connection_id,
                rules,
                ..
            } => {
                assert_eq!(
                    connection_id.as_deref(),
                    Some("c1"),
                    "the calendar connection serves this path and must win"
                );
                assert!(rules.iter().any(|r| r.path_pattern == "/calendar/*"));
            }
            _ => panic!("expected Rules"),
        }

        // With no other connection serving the path, the pin still stands.
        let only_gmail = vec![gm];
        let res = engine
            .resolve_app_injection_for_request(
                &only_gmail,
                "www.googleapis.com",
                Some("/calendar/v3/calendars/primary/events"),
                Some("c2"),
                "o1",
                "p1",
                &*store,
            )
            .await
            .unwrap();
        assert!(matches!(res, AppConnectionResult::Rules { .. }));
    }

    #[tokio::test]
    async fn mismatched_pin_with_two_serving_accounts_stays_ambiguous() {
        // A Gmail pin on a CALENDAR path where TWO Calendar accounts are
        // attached: ignoring the pin must never silently pick one of them —
        // account choice is the agent's, so the fallback lands on the same
        // Ambiguous 409 the no-pin path would give (the response names the
        // choices and the pin header to send).
        let engine = PolicyEngine::test_stub();
        let store = new_store().await;
        let cal_a = conn("c1", "google-calendar");
        let cal_b = conn("c2", "google-calendar");
        let gm = conn("c3", "gmail");
        seed_app_injection(
            &store,
            &cal_a,
            "www.googleapis.com",
            vec![bearer_rule("/calendar/*", "cal-a")],
            None,
            Some("Cal A"),
        )
        .await;
        seed_app_injection(
            &store,
            &cal_b,
            "www.googleapis.com",
            vec![bearer_rule("/calendar/*", "cal-b")],
            None,
            Some("Cal B"),
        )
        .await;
        seed_app_injection(
            &store,
            &gm,
            "www.googleapis.com",
            vec![bearer_rule("/gmail/*", "gm")],
            None,
            Some("Gm"),
        )
        .await;

        let conns = vec![cal_a, cal_b, gm];
        let res = engine
            .resolve_app_injection_for_request(
                &conns,
                "www.googleapis.com",
                Some("/calendar/v3/calendars/primary/events"),
                Some("c3"),
                "o1",
                "p1",
                &*store,
            )
            .await
            .unwrap();
        match res {
            AppConnectionResult::Ambiguous { connections } => {
                let mut ids: Vec<&str> = connections.iter().map(|c| c.id.as_str()).collect();
                ids.sort_unstable();
                assert_eq!(ids, vec!["c1", "c2"], "both Calendar accounts offered");
            }
            _ => panic!("expected Ambiguous"),
        }
    }

    #[tokio::test]
    async fn merge_loop_drops_metadata_when_no_provider_serves() {
        // Two providers, neither serving the request path (/youtube): the
        // empty-narrow fallback keeps both, their rules merge (they
        // self-select at apply time), and no one's metadata is adopted.
        let engine = PolicyEngine::test_stub();
        let store = new_store().await;
        let cal = conn("c1", "google-calendar");
        let gm = conn("c2", "gmail");
        seed_app_injection(
            &store,
            &cal,
            "www.googleapis.com",
            vec![bearer_rule("/calendar/*", "cal")],
            Some("cal.example.com"),
            Some("Cal"),
        )
        .await;
        seed_app_injection(
            &store,
            &gm,
            "www.googleapis.com",
            vec![bearer_rule("/gmail/*", "gm")],
            Some("gm.example.com"),
            Some("Gm"),
        )
        .await;

        let res = engine
            .resolve_app_injection_for_request(
                &[cal, gm],
                "www.googleapis.com",
                Some("/youtube/v3/search"),
                None,
                "o1",
                "p1",
                &*store,
            )
            .await
            .unwrap();
        match res {
            AppConnectionResult::Rules {
                rules,
                rewrite_host,
                connection_label,
                session_policy,
                connection_id,
                ..
            } => {
                assert_eq!(rules.len(), 2);
                assert!(rewrite_host.is_none());
                assert!(connection_label.is_none());
                assert!(session_policy.is_none());
                assert!(connection_id.is_none(), "no serving provider → no winner");
            }
            _ => panic!("expected Rules"),
        }
    }

    #[test]
    fn narrow_calendar_request_selects_calendar_connection() {
        // The bug: with two Gmail accounts, every www.googleapis.com path was
        // ambiguous. A Calendar request must narrow to the single Calendar
        // connection so it injects without an x-onecli-connection-id header.
        let conns = vec![
            conn("gmail1", "gmail"),
            conn("gmail2", "gmail"),
            conn("cal1", "google-calendar"),
            conn("drive1", "google-drive"),
        ];
        let narrowed = narrow_connections_by_path(
            &conns,
            "www.googleapis.com",
            Some("/calendar/v3/calendars/primary/events"),
        );
        assert_eq!(ids(&narrowed), vec!["cal1"]);
    }

    #[test]
    fn narrow_gmail_request_keeps_both_gmail_accounts() {
        // A Gmail request with two Gmail accounts stays genuinely ambiguous —
        // narrowing keeps both so the caller still asks for a connection-id.
        let conns = vec![
            conn("gmail1", "gmail"),
            conn("gmail2", "gmail"),
            conn("cal1", "google-calendar"),
        ];
        let narrowed = narrow_connections_by_path(
            &conns,
            "www.googleapis.com",
            Some("/gmail/v1/users/me/messages"),
        );
        assert_eq!(ids(&narrowed), vec!["gmail1", "gmail2"]);
    }

    #[test]
    fn narrow_falls_back_to_full_set_when_nothing_serves_path() {
        // No connection serves the path → return the full set unchanged rather
        // than an empty set, preserving prior behavior for that edge case.
        let conns = vec![conn("gmail1", "gmail"), conn("gmail2", "gmail")];
        let narrowed =
            narrow_connections_by_path(&conns, "www.googleapis.com", Some("/calendar/v3"));
        assert_eq!(ids(&narrowed), vec!["gmail1", "gmail2"]);
    }

    #[test]
    fn narrow_leaves_dedicated_host_untouched() {
        // gmail.googleapis.com is not path-scoped (single provider, no path
        // prefix), so the full set is returned — two Gmail accounts stay
        // ambiguous there, which is correct.
        let conns = vec![conn("gmail1", "gmail"), conn("gmail2", "gmail")];
        let narrowed = narrow_connections_by_path(
            &conns,
            "gmail.googleapis.com",
            Some("/gmail/v1/users/me/messages"),
        );
        assert_eq!(ids(&narrowed), vec!["gmail1", "gmail2"]);
    }

    #[test]
    fn narrow_without_request_path_returns_full_set() {
        let conns = vec![conn("gmail1", "gmail"), conn("cal1", "google-calendar")];
        let narrowed = narrow_connections_by_path(&conns, "www.googleapis.com", None);
        assert_eq!(ids(&narrowed), vec!["gmail1", "cal1"]);
    }

    #[test]
    fn narrow_leaves_non_google_host_untouched() {
        let conns = vec![conn("github1", "github")];
        let narrowed = narrow_connections_by_path(&conns, "api.github.com", Some("/repos/foo/bar"));
        assert_eq!(ids(&narrowed), vec!["github1"]);
    }

    #[test]
    fn narrow_single_connection_is_returned_borrowed_unchanged() {
        // A single connection can't be disambiguated: it is returned as-is and
        // without a clone (Borrowed), even on a path-scoped host it does not
        // serve — the common single-account case stays on the zero-copy path.
        let conns = vec![conn("gmail1", "gmail")];
        let narrowed =
            narrow_connections_by_path(&conns, "www.googleapis.com", Some("/calendar/v3"));
        assert_eq!(ids(&narrowed), vec!["gmail1"]);
        assert!(matches!(narrowed, Cow::Borrowed(_)));
    }
}

#[cfg(test)]
mod stamp_resource_scopes_tests {
    use super::*;

    fn conn(id: &str) -> db::AppConnectionRow {
        db::AppConnectionRow {
            id: id.into(),
            provider: "github-app".into(),
            scope: "workspace".into(),
            credentials: None,
            label: None,
            metadata: None,
            // The SELECTs hardcode NULL here, so every row starts unscoped.
            session_policy: None,
        }
    }

    fn selection(
        connections: &[(&str, Option<serde_json::Value>)],
        boundaries: &[(&str, serde_json::Value)],
    ) -> db::InjectSelection {
        db::InjectSelection {
            connections: connections
                .iter()
                .map(|(id, p)| ((*id).to_string(), p.clone()))
                .collect(),
            boundaries: boundaries
                .iter()
                .map(|(id, b)| ((*id).to_string(), b.clone()))
                .collect(),
            ..Default::default()
        }
    }

    /// The whole truth table of what a connection may reach, by how it was
    /// granted and whether the organization bounds it.
    #[test]
    fn stamps_the_scope_each_connection_may_actually_reach() {
        let mut rows = vec![conn("named"), conn("by-provider"), conn("unbounded")];
        let sel = selection(
            &[
                // Named grant: its own selection (the fold already composed the
                // boundary in, so re-applying must not change it).
                (
                    "named",
                    Some(serde_json::json!({ "repositories": ["org/a"] })),
                ),
                ("unbounded", Some(serde_json::json!({ "folders": ["/x"] }))),
            ],
            &[
                ("named", serde_json::json!({ "repositories": ["org/a"] })),
                // Granted by provider scope: the fold never saw this id, so the
                // boundary can only be applied here.
                (
                    "by-provider",
                    serde_json::json!({ "repositories": ["org/b"] }),
                ),
            ],
        );

        stamp_resource_scopes(&mut rows, &sel, true);

        assert_eq!(
            rows[0].session_policy,
            Some(serde_json::json!({ "repositories": ["org/a"] })),
            "a named grant keeps its composed scope — re-application is a no-op"
        );
        assert_eq!(
            rows[1].session_policy,
            Some(serde_json::json!({ "repositories": ["org/b"] })),
            "a provider-level grant inherits the boundary it never named"
        );
        assert_eq!(
            rows[2].session_policy,
            Some(serde_json::json!({ "folders": ["/x"] })),
            "with no boundary the selection stands alone"
        );
    }

    #[test]
    fn a_connection_with_neither_reaches_everything_it_always_did() {
        let mut rows = vec![conn("plain")];
        stamp_resource_scopes(&mut rows, &selection(&[("plain", None)], &[]), true);
        assert_eq!(rows[0].session_policy, None);
    }

    #[test]
    fn a_boundary_disjoint_from_the_selection_reaches_nothing() {
        let mut rows = vec![conn("c1")];
        let sel = selection(
            &[("c1", Some(serde_json::json!({ "repositories": ["org/z"] })))],
            &[("c1", serde_json::json!({ "repositories": ["org/a"] }))],
        );
        stamp_resource_scopes(&mut rows, &sel, true);
        assert_eq!(
            rows[0].session_policy,
            Some(serde_json::json!({ "repositories": [] })),
            "an empty overlap is the deny-all sentinel, not an absent scope"
        );
    }

    #[test]
    fn unlicensed_stamps_no_session_policy_at_all() {
        // #39/#40: with the flag off no scope is stamped — selection AND
        // boundary alike are ignored, so the credential injects unscoped
        // (deliberate: no EE behavior survives unlicensed, narrowing included).
        let mut rows = vec![conn("named"), conn("by-provider")];
        let sel = selection(
            &[(
                "named",
                Some(serde_json::json!({ "repositories": ["org/a"] })),
            )],
            &[(
                "by-provider",
                serde_json::json!({ "repositories": ["org/b"] }),
            )],
        );
        stamp_resource_scopes(&mut rows, &sel, false);
        assert_eq!(rows[0].session_policy, None);
        assert_eq!(rows[1].session_policy, None);
    }
}

#[cfg(test)]
mod deferred_injection_tests {
    use super::*;
    use cache::CacheStore;

    async fn store() -> Arc<dyn CacheStore> {
        cache::in_memory()
    }

    /// A GitHub App connection carrying real (test-key) encrypted credentials:
    /// the deferral decision happens after decryption, because the decrypted
    /// payload is what the deferred mint will consume.
    async fn github_conn(
        engine: &PolicyEngine,
        session_policy: Option<serde_json::Value>,
    ) -> db::AppConnectionRow {
        let creds = engine
            .crypto
            .encrypt(
                &serde_json::json!({
                    "type": "github_app",
                    "app_id": "1",
                    "installation_id": "2",
                    "private_key": "k",
                    "expires_at": 0,
                })
                .to_string(),
            )
            .await
            .expect("encrypt test credentials");
        db::AppConnectionRow {
            id: "c-gh".into(),
            provider: "github-app".into(),
            scope: "workspace".into(),
            credentials: Some(creds),
            label: Some("gh".into()),
            metadata: None,
            session_policy,
        }
    }

    #[test]
    fn granular_scoping_is_requested_only_by_a_non_empty_policy_object() {
        assert!(granular_scoping_requested(Some(&serde_json::json!({
            "repositories": ["org/a"]
        }))));
        // Absent, null, empty object, or behavioral conditions: no scoped mint.
        assert!(!granular_scoping_requested(None));
        assert!(!granular_scoping_requested(Some(&serde_json::json!(null))));
        assert!(!granular_scoping_requested(Some(&serde_json::json!({}))));
        assert!(!granular_scoping_requested(Some(&serde_json::json!([
            { "type": "body_contains", "value": "x" }
        ]))));
    }

    /// The point of the deferral: a resource-scoped connection yields no rules
    /// during resolution — the credential is minted only once the request is
    /// allowed — while still reporting that it WILL inject, so the request
    /// stays managed and the deny-defaults keep applying. The deferral exists
    /// exactly where a token scoper does, and the scoper compiles everywhere.
    #[tokio::test]
    async fn a_resource_scoped_connection_defers_its_credential() {
        let engine = PolicyEngine::test_stub();
        let cache = store().await;
        let conn = github_conn(
            &engine,
            Some(serde_json::json!({ "repositories": ["org/a"] })),
        )
        .await;

        let result = engine
            .resolve_app_injection_for_request(
                std::slice::from_ref(&conn),
                "api.github.com",
                Some("/repos/org/a"),
                None,
                "org-1",
                "proj-1",
                &*cache,
            )
            .await
            .expect("resolution");

        match result {
            AppConnectionResult::Rules { rules, pending, .. } => {
                assert!(rules.is_empty(), "no credential built during resolution");
                assert_eq!(pending.len(), 1, "the mint is pending, not skipped");
                assert_eq!(pending[0].conn.id, "c-gh");
            }
            _ => panic!("expected Rules"),
        }
    }

    /// A connection with no resource scope mints as it always did — deferral is
    /// narrowly for the live, never-persisted scoped credential.
    #[tokio::test]
    async fn an_unscoped_connection_is_not_deferred() {
        let engine = PolicyEngine::test_stub();
        let cache = store().await;
        let conn = github_conn(&engine, None).await;

        let result = engine
            .resolve_app_injection_for_request(
                std::slice::from_ref(&conn),
                "api.github.com",
                Some("/repos/org/a"),
                None,
                "org-1",
                "proj-1",
                &*cache,
            )
            .await
            .expect("resolution");

        match result {
            AppConnectionResult::Rules { pending, .. } => {
                assert!(pending.is_empty(), "nothing to defer without a scope");
            }
            // No credentials on the row, so resolution yields nothing at all —
            // also acceptable, and equally free of pending work.
            AppConnectionResult::NoConnections => {}
            _ => panic!("expected Rules or NoConnections"),
        }
    }

    /// The fail-closed law: when a scoped credential is REQUIRED but cannot be
    /// minted, nothing is injected. The stored credential is the unrestricted
    /// one — handing it over would grant exactly the access the policy exists
    /// to withhold, and it would do so silently.
    #[tokio::test]
    async fn a_scoped_credential_that_cannot_be_minted_injects_nothing() {
        let engine = PolicyEngine::test_stub();
        let cache = store().await;
        // An empty allowlist reaches nothing; the GitHub scoper refuses to turn
        // it into a mint request (which GitHub would read as "every repo").
        let conn = github_conn(&engine, Some(serde_json::json!({ "repositories": [] }))).await;

        let materialized = engine
            .materialize_pending(
                &PendingInjection {
                    conn: conn.clone(),
                    decrypted_json: engine
                        .crypto
                        .decrypt(conn.credentials.as_ref().expect("creds"))
                        .await
                        .expect("decrypt"),
                    hostname: "api.github.com".to_string(),
                    cache_key: "app_injection:test:deny-all".to_string(),
                    workspace_id: "proj-1".to_string(),
                },
                &*cache,
            )
            .await;

        assert!(
            materialized.is_none(),
            "no credential may be injected when the scoped mint is refused"
        );
    }

    /// A REQUEST-LEVEL provider (Dropbox's folder guard) keeps its plain stored
    /// credential: the guard is what restricts each call, so withholding the
    /// token would not tighten anything — it would break granular access
    /// altogether. Only token-scoped providers withhold when the mint fails.
    #[tokio::test]
    async fn a_request_guarded_provider_keeps_its_credential_under_a_scope() {
        let engine = PolicyEngine::test_stub();
        let cache = store().await;
        let creds = engine
            .crypto
            .encrypt(&serde_json::json!({ "access_token": "dbx-token" }).to_string())
            .await
            .expect("encrypt");
        let conn = db::AppConnectionRow {
            id: "c-dbx".into(),
            provider: "dropbox".into(),
            scope: "workspace".into(),
            credentials: Some(creds),
            label: Some("dbx".into()),
            metadata: None,
            session_policy: Some(serde_json::json!({ "folders": ["/clients"] })),
        };

        let result = engine
            .resolve_app_injection_for_request(
                std::slice::from_ref(&conn),
                "api.dropboxapi.com",
                Some("/2/files/list_folder"),
                None,
                "org-1",
                "proj-1",
                &*cache,
            )
            .await
            .expect("resolution");

        match result {
            AppConnectionResult::Rules {
                rules,
                pending,
                session_policy,
                ..
            } => {
                assert!(pending.is_empty(), "no token scoper, nothing to defer");
                assert!(!rules.is_empty(), "the plain credential still injects");
                assert_eq!(
                    session_policy,
                    Some(serde_json::json!({ "folders": ["/clients"] })),
                    "the guard needs the policy to enforce against"
                );
            }
            _ => panic!("expected Rules — withholding here would break Dropbox scoping"),
        }
    }

    /// A warm cache already holds the built rules, so there is nothing left to
    /// defer: the provider call happened for an earlier request.
    #[tokio::test]
    async fn a_cached_connection_never_defers() {
        let engine = PolicyEngine::test_stub();
        let cache = store().await;
        let conn = github_conn(
            &engine,
            Some(serde_json::json!({ "repositories": ["org/a"] })),
        )
        .await;
        seed_app_injection_cache(
            &cache,
            "org-1",
            "proj-1",
            &conn,
            "api.github.com",
            vec![InjectionRule {
                path_pattern: "*".to_string(),
                injections: vec![Injection::SetHeader {
                    name: "authorization".to_string(),
                    value: "Bearer cached".to_string(),
                }],
            }],
            None,
            None,
        )
        .await;

        let result = engine
            .resolve_app_injection_for_request(
                std::slice::from_ref(&conn),
                "api.github.com",
                Some("/repos/org/a"),
                None,
                "org-1",
                "proj-1",
                &*cache,
            )
            .await
            .expect("resolution");

        match result {
            AppConnectionResult::Rules { rules, pending, .. } => {
                assert!(pending.is_empty(), "a cache hit has nothing to mint");
                assert_eq!(rules.len(), 1);
            }
            _ => panic!("expected Rules"),
        }
    }
}
