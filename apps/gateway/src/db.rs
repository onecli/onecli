//! Direct database access via SQLx.
//!
//! Used when `DATABASE_URL` is set to query the PostgreSQL database directly,
//! bypassing the Next.js API. Vault connection state is managed by the gateway;
//! all other tables are read-only (Prisma / Next.js remains the writer).

use anyhow::{Context, Result};
use sqlx::postgres::PgPoolOptions;
use sqlx::{types::Json, FromRow, PgPool};

/// Create a PostgreSQL connection pool from `DATABASE_URL`.
pub(crate) async fn create_pool(database_url: &str) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await
        .context("connecting to PostgreSQL")
}

// ── Row types ───────────────────────────────────────────────────────────

/// An agent row from the `agents` table.
#[derive(Debug, FromRow)]
pub(crate) struct AgentRow {
    pub id: String,
    pub name: String,
    pub identifier: Option<String>,
    pub workspace_id: String,
    pub organization_id: String,
    pub subscription_status: String,
}

/// A secret row from the `secrets` table.
#[derive(Debug, FromRow)]
pub(crate) struct SecretRow {
    pub id: String,
    /// "workspace" | "organization". Read by the budget module (`BudgetSecret`
    /// impl) to identify a budget-eligible credential by its actual scope.
    pub scope: String,
    #[sqlx(rename = "type")]
    pub type_: String,
    /// "inline" (value stored in `encrypted_value`) | "onepassword" (value
    /// resolved from `op_ref` via the 1Password connection at request time).
    pub value_source: String,
    /// Present for inline secrets; `None` for 1Password-sourced ones.
    pub encrypted_value: Option<String>,
    /// `op://vault/item/field` reference, set for 1Password-sourced secrets.
    pub op_ref: Option<String>,
    pub host_pattern: String,
    pub path_pattern: Option<String>,
    pub injection_config: Option<serde_json::Value>,
    pub metadata: Option<serde_json::Value>,
}

/// A user row from the `users` table.
#[derive(Debug, FromRow)]
pub(crate) struct UserRow {
    pub id: String,
}

/// An API key row from the `api_keys` table (workspace-scoped).
#[derive(Debug, FromRow)]
pub(crate) struct ApiKeyRow {
    pub user_id: String,
    pub workspace_id: String,
}

/// An org-scoped API key row from the `api_keys` table.
///
/// Queried by the merged auth path in every edition (`auth.rs`); the
/// admin/owner ROLE recheck on top is cloud-gated, while active-membership
/// liveness is checked everywhere.
#[derive(Debug, FromRow)]
pub(crate) struct OrgApiKeyRow {
    pub user_id: String,
    pub organization_id: String,
}

/// A vault connection row from the `vault_connections` table.
#[derive(Debug, FromRow)]
#[allow(dead_code)]
pub(crate) struct VaultConnectionRow {
    pub id: String,
    pub provider: String,
    pub name: Option<String>,
    pub status: String,
    pub connection_data: Option<serde_json::Value>,
}

// ── Queries ─────────────────────────────────────────────────────────────

/// Look up a user by their external auth ID (the identity provider's subject).
pub(crate) async fn find_user_by_external_auth_id(
    pool: &PgPool,
    external_auth_id: &str,
) -> Result<Option<UserRow>> {
    sqlx::query_as::<_, UserRow>(r#"SELECT id FROM users WHERE external_auth_id = $1 LIMIT 1"#)
        .bind(external_auth_id)
        .fetch_optional(pool)
        .await
        .context("querying user by external_auth_id")
}

/// Resolve a live browser session to its user.
///
/// The session table is the self-hosted identity layer's source of truth
/// (better-auth writes it): the cookie carries this token, and signing out or
/// revoking deletes the row, so a withdrawn session stops resolving here the
/// moment it is withdrawn — no token lifetime to wait out. Expiry is checked
/// in the query for the same reason: the row outlives its validity until
/// something sweeps it.
pub(crate) async fn find_user_by_session_token(
    pool: &PgPool,
    token: &str,
) -> Result<Option<UserRow>> {
    sqlx::query_as::<_, UserRow>(
        r#"SELECT u.id
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           WHERE s.token = $1 AND s.expires_at > (now() AT TIME ZONE 'utc')
           LIMIT 1"#,
    )
    .bind(token)
    .fetch_optional(pool)
    .await
    .context("querying user by session token")
}

/// Find the default workspace ID for a user (onprem session fallback).
///
/// Resolves user → first organization → first workspace in that organization.
/// Mirrors the web's `resolveUser()` (apps/web/src/lib/actions/resolve-user.ts).
///
/// Only called on the onprem session fallback: the cloud edition is
/// multi-workspace and never falls back to a default workspace — it requires an
/// explicit `X-Workspace-Id` and validates it with [`user_can_access_workspace`].
pub(crate) async fn find_default_workspace_id_by_user(
    pool: &PgPool,
    user_id: &str,
) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        r#"SELECT p.id
           FROM organization_members om
           INNER JOIN workspaces p ON p.organization_id = om.organization_id
           WHERE om.user_id = $1 AND om.status <> 'suspended'
           ORDER BY om.created_at ASC, p.created_at ASC
           LIMIT 1"#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .context("querying default workspace for user via organization_members")?;

    Ok(row.map(|(id,)| id))
}

/// Look up an API key (`oc_...`) and return its user_id and workspace_id.
pub(crate) async fn find_api_key(pool: &PgPool, key: &str) -> Result<Option<ApiKeyRow>> {
    sqlx::query_as::<_, ApiKeyRow>(
        r#"SELECT user_id, workspace_id FROM api_keys WHERE key = $1 LIMIT 1"#,
    )
    .bind(key)
    .fetch_optional(pool)
    .await
    .context("querying api_keys by key")
}

/// Look up an org-scoped API key (`oc_org_...`) and return its user_id and organization_id.
pub(crate) async fn find_org_api_key(pool: &PgPool, key: &str) -> Result<Option<OrgApiKeyRow>> {
    sqlx::query_as::<_, OrgApiKeyRow>(
        r#"SELECT user_id, organization_id
           FROM api_keys
           WHERE key = $1 AND scope = 'organization' AND organization_id IS NOT NULL
           LIMIT 1"#,
    )
    .bind(key)
    .fetch_optional(pool)
    .await
    .context("querying org api_keys by key")
}

/// Verify that a workspace belongs to the given organization.
pub(crate) async fn verify_workspace_in_org(
    pool: &PgPool,
    workspace_id: &str,
    organization_id: &str,
) -> Result<bool> {
    let row: Option<(String,)> = sqlx::query_as(
        r#"SELECT id FROM workspaces WHERE id = $1 AND organization_id = $2 LIMIT 1"#,
    )
    .bind(workspace_id)
    .bind(organization_id)
    .fetch_optional(pool)
    .await
    .context("verifying workspace belongs to organization")?;
    Ok(row.is_some())
}

/// Verify that a user may access a workspace — i.e. the workspace belongs to an
/// organization the user is a member of. Scopes cloud browser (Cognito)
/// requests to the `X-Workspace-Id` they specify instead of a default workspace.
pub(crate) async fn user_can_access_workspace(
    pool: &PgPool,
    user_id: &str,
    workspace_id: &str,
) -> Result<bool> {
    let row: Option<(String,)> = sqlx::query_as(
        r#"SELECT p.id
           FROM organization_members om
           INNER JOIN workspaces p ON p.organization_id = om.organization_id
           WHERE om.user_id = $1 AND p.id = $2
             AND om.status <> 'suspended'
           LIMIT 1"#,
    )
    .bind(user_id)
    .bind(workspace_id)
    .fetch_optional(pool)
    .await
    .context("verifying user has access to workspace")?;
    Ok(row.is_some())
}

/// Whether a user is an ACTIVE (non-suspended) member of an organization. The
/// unconditional LIVENESS gate on org-key auth — checked in every edition, so
/// an org key dies the moment its user is suspended or removed. The
/// admin/owner ROLE recheck on top ([`crate::ee::rbac::user_is_org_admin`])
/// runs only on cloud or a licensed self-host.
pub(crate) async fn user_is_active_org_member(
    pool: &PgPool,
    user_id: &str,
    organization_id: &str,
) -> Result<bool> {
    let row: Option<(String,)> = sqlx::query_as(
        r#"SELECT user_id
           FROM organization_members
           WHERE user_id = $1 AND organization_id = $2
             AND status <> 'suspended'
           LIMIT 1"#,
    )
    .bind(user_id)
    .bind(organization_id)
    .fetch_optional(pool)
    .await
    .context("verifying user is an active org member")?;
    Ok(row.is_some())
}

/// Look up an agent by its access token.
pub(crate) async fn find_agent_by_token(
    pool: &PgPool,
    access_token: &str,
) -> Result<Option<AgentRow>> {
    sqlx::query_as::<_, AgentRow>(
        r#"SELECT a.id, a.name, a.identifier, a.workspace_id, p.organization_id, o.subscription_status
           FROM agents a
           JOIN workspaces p ON a.workspace_id = p.id
           JOIN organizations o ON p.organization_id = o.id
           WHERE a.access_token = $1
           LIMIT 1"#,
    )
    .bind(access_token)
    .fetch_optional(pool)
    .await
    .context("querying agent by access_token")
}

/// Look up the organization ID for a workspace.
pub(crate) async fn find_organization_id_by_workspace(
    pool: &PgPool,
    workspace_id: &str,
) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as(r#"SELECT organization_id FROM workspaces WHERE id = $1 LIMIT 1"#)
            .bind(workspace_id)
            .fetch_optional(pool)
            .await
            .context("querying organization_id by workspace_id")?;
    Ok(row.map(|(oid,)| oid))
}

/// Find all secrets for a given workspace.
pub(crate) async fn find_secrets_by_workspace(
    pool: &PgPool,
    workspace_id: &str,
) -> Result<Vec<SecretRow>> {
    sqlx::query_as::<_, SecretRow>(
        r#"SELECT id, scope, type, value_source, encrypted_value, op_ref, host_pattern, path_pattern, injection_config, metadata FROM secrets WHERE workspace_id = $1"#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .context("querying secrets by workspace_id")
}

/// Find all organization-level secrets.
pub(crate) async fn find_secrets_by_org(
    pool: &PgPool,
    organization_id: &str,
) -> Result<Vec<SecretRow>> {
    sqlx::query_as::<_, SecretRow>(
        r#"SELECT id, scope, type, value_source, encrypted_value, op_ref, host_pattern, path_pattern, injection_config, metadata
           FROM secrets
           WHERE organization_id = $1 AND scope = 'organization'"#,
    )
    .bind(organization_id)
    .fetch_all(pool)
    .await
    .context("querying secrets by organization_id")
}

/// Update a secret's encrypted value (used for token refresh).
pub(crate) async fn update_secret_value(
    pool: &PgPool,
    secret_id: &str,
    encrypted_value: &str,
) -> Result<()> {
    sqlx::query(r#"UPDATE secrets SET encrypted_value = $1, updated_at = NOW() WHERE id = $2"#)
        .bind(encrypted_value)
        .bind(secret_id)
        .execute(pool)
        .await
        .context("updating secret encrypted value")?;
    Ok(())
}

// ── New-model policy queries (policy_rules_v2) ─────────────────────────────
//
// Shared since step 9.5: every edition's engine loads the ACTIVE published
// generation of a scope's rules with their identities + targets aggregated as
// JSON (parsed by the engine's assembler), ordered by `priority` (first-match
// order). The differentiating loaders (org scope, principal set, availability)
// live in the EE overlay (`ee/policy_engine/loaders.rs`) and are never part of
// the OSS build.

/// One aggregated identity (from `json_agg`, camelCase keys). Exactly one of the
/// three principal columns is set per row (the DB `one_principal` CHECK); the
/// engine decodes it to the matching `Identity` variant. The non-agent kinds
/// are cloud/EE-only (OSS decodes them fail-closed).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PolicyIdentityRow {
    pub agent_id: Option<String>,
    pub user_id: Option<String>,
    pub group_id: Option<String>,
}

/// One aggregated target (camelCase keys). `app_connection_id`/`secret_id`
/// (step 8) name a specific credential to INJECT at connect — and the block/allow
/// engine ALSO gates their hosts: a secret target by its resolved host pattern,
/// a connection target by its provider's catalog hosts (permit on allow, block on
/// block — the app/secret symmetry).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PolicyTargetRow {
    pub kind: String,
    pub app_provider: Option<String>,
    #[serde(default)]
    pub app_tools: Vec<String>,
    /// kind=app (step 8): "organization" | "workspace" → inject ALL the agent's
    /// connections of `app_provider` at that level; NULL = the app-permission
    /// block/allow rule (no injection).
    pub app_connection_scope: Option<String>,
    pub app_connection_id: Option<String>,
    pub secret_id: Option<String>,
    /// kind=secret (step 8): "organization" | "workspace" → inject ALL the agent's
    /// secrets at that level; NULL = a specific `secret_id` target.
    pub secret_scope: Option<String>,
    pub host_pattern: Option<String>,
    pub path_pattern: Option<String>,
    pub method: Option<String>,
}

/// A published `policy_rules_v2` rule with its identity + target rows aggregated
/// into JSON arrays, DECODED into typed vectors at load (`Json<Vec<…>>`). Serde so
/// it rides in `ConnectResponse` — loaded once at connection resolution (cached
/// 60s), so the per-request decision path never touches the DB and, because the
/// JSON is parsed here at load, never re-parses the aggregate per request either.
#[derive(Debug, Clone, PartialEq, FromRow, serde::Serialize, serde::Deserialize)]
pub(crate) struct PolicyRuleV2Row {
    pub id: String,
    /// Generation-stable identity — the rate counter keys on it (survives republishes).
    pub logical_id: String,
    pub name: String,
    /// Rule origin (custom | app_permission | blocklist | default | equipment).
    /// `equipment` (step 8) rules are INJECTION-ONLY — the block/allow assembler
    /// drops them; the connect-time inject-selection reads them.
    pub source: String,
    pub priority: i32,
    pub is_default: bool,
    pub action: String,
    pub rate_limit: Option<i32>,
    pub rate_limit_window: Option<String>,
    pub require_approval: bool,
    pub conditions: Option<serde_json::Value>,
    pub identities: Json<Vec<PolicyIdentityRow>>,
    pub targets: Json<Vec<PolicyTargetRow>>,
}

/// The agent's principal context for a connection — a cloud/EE-only shape,
/// resolved by the EE loaders at connection resolution. Always empty in OSS
/// (agent-only identities); part of the shared `ConnectResponse` so both
/// builds serialize the same struct.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct PrincipalSet {
    /// Human users the agent's workspace grants via WorkspaceAccess — directly, or as
    /// members of a granted group.
    pub user_ids: Vec<String>,
    /// Directory groups to match: those granted to the workspace directly, plus
    /// every group the inherited users belong to (org-fenced).
    pub group_ids: Vec<String>,
}

/// The published new-model rules for a connection's org + workspace scopes, loaded
/// during connection resolution (cached with `ConnectResponse`). Empty when the
/// engine is off, the org isn't backfilled, or a load errored — the enforce seam
/// then reverts to the legacy path. Shared so `ConnectResponse` can carry it;
/// only cloud ever populates it.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct PolicyV2Rules {
    pub org: Vec<PolicyRuleV2Row>,
    pub workspace: Vec<PolicyRuleV2Row>,
    /// The connection's resolved principal set (step 6). Empty unless some
    /// loaded rule targets a user/group identity (lazy). Only cloud ever
    /// populates it.
    #[serde(default)]
    pub principals: PrincipalSet,
    /// The org+workspace custom secrets' host patterns (step 8), so a `secret` target
    /// can permit/deny its host DB-free per request. Empty unless a loaded rule has
    /// a secret target (lazy). Populated by both the OSS core and the EE engine
    /// (`find_secret_hosts` is shared).
    #[serde(default)]
    pub secret_hosts: SecretHosts,
    /// The org+workspace app connections' providers, so a `connection` target can
    /// resolve to its provider's catalog hosts and permit/deny them DB-free per
    /// request (the step-8 secret symmetry). Empty unless a loaded rule has a
    /// connection target (lazy). Only cloud ever populates it.
    #[serde(default)]
    pub connection_providers: ConnectionProviders,
}

/// The host patterns of the acting org+workspace custom secrets, resolved ONCE at
/// connection resolution (cached with `PolicyV2Rules`) so the block/allow engine
/// can let a `secret` target PERMIT/deny its host DB-free per request (step 8).
/// `by_id` serves a specific `secret_id` target; `workspace_hosts`/`org_hosts` serve
/// a `secret_scope` ("all secrets at a level") target. Each secret contributes ALL
/// the hosts its credential injects on (`secret_inject::secret_host_patterns`) — a
/// list, because an OAuth-mode OpenAI secret is valid on several hosts — so
/// enforcement covers at least the injection surface (injection additionally
/// carves out `auth.openai.com`; wider enforcement is fail-safe). Populated
/// whenever a loaded rule has a
/// secret target (the lazy skip leaves it empty otherwise).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct SecretHosts {
    /// A specific secret's id → every host pattern its credential injects on.
    pub by_id: std::collections::HashMap<String, Vec<String>>,
    /// Every WORKSPACE-scoped secret's host patterns (for `secret_scope="workspace"`).
    pub workspace_hosts: Vec<String>,
    /// Every ORG-scoped secret's host patterns (for `secret_scope="organization"`).
    pub org_hosts: Vec<String>,
}

/// The providers of the acting org+workspace app connections, resolved ONCE at
/// connection resolution (cached with `PolicyV2Rules`) so the block/allow engine
/// can decode a `connection` target to its provider — whose catalog hosts it then
/// permits/denies, symmetric with a `secret` target (step 8). Fenced at load
/// (`find_connection_providers`), so a forged/foreign connection id resolves to
/// nothing (the target never matches — fail-closed, like a deleted secret). Empty
/// in OSS and whenever no loaded rule has a connection target (the lazy skip).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct ConnectionProviders {
    /// A connection's id → its `provider` (e.g. "gmail").
    pub by_id: std::collections::HashMap<String, String>,
}

/// The specific credentials the connect's published v2 rules ALLOW the
/// requesting agent to have injected — derived ONCE at connect-resolution from
/// the already-loaded `PolicyV2Rules` (pure, DB-free). Since attach-model step 7
/// this selection is the WHOLE story for the org/workspace tiers — every agent is
/// rule-selected (the legacy `agents.secret_mode` column is dropped).
/// NOT cached on its own — it feeds the resolvers whose output
/// (`injection_rules` / `app_connections`) is what rides `ConnectResponse`.
#[derive(Debug, Clone, Default)]
pub(crate) struct InjectSelection {
    /// Specific `Secret` ids named by the agent's matching `kind=secret` allow
    /// targets.
    pub secret_ids: std::collections::HashSet<String>,
    /// Specific `AppConnection` id → its `sessionPolicy` (the matching rule's
    /// conditions — the granular guard) for `kind=connection` allow targets.
    pub connections: std::collections::HashMap<String, Option<serde_json::Value>>,
    /// (provider, level) pairs from `kind=app` allow targets carrying a
    /// `connection_scope`: inject ALL the agent's connections of `provider` at
    /// that org/workspace `level`. The grant itself carries no per-connection
    /// sessionPolicy — but the connections it resolves to are still bounded by
    /// `boundaries` below, applied where those ids are read from the database.
    pub app_scopes: Vec<(String, String)>,
    /// Connection id → the ORG's resource boundary for it, when the
    /// organization restricts how far that credential may reach. Kept separate
    /// from `connections` because a boundary is not a grant: it applies to
    /// whatever the agent ends up with, including a connection pulled in by an
    /// `app_scopes` (provider-level) grant, which is resolved from the database
    /// long after the rules are folded. Always empty in OSS.
    pub boundaries: std::collections::HashMap<String, serde_json::Value>,
    /// Levels ("organization" | "workspace") from `kind=secret` allow targets
    /// carrying a `secret_scope`: inject ALL the agent's secrets at that level
    /// (a level selection, no per-secret guard).
    pub secret_scopes: Vec<String>,
}

/// The apps a connection's workspace may reach (a licensed posture, resolved
/// by `crate::ee::principals` at connection resolution). `restricted = false`
/// — the default, and always on unlicensed deployments — means EVERY app is
/// available and the per-request pre-check is a no-op. INVARIANT: only the
/// licensed loader may ever produce `restricted: true` — that one bool is
/// what keeps the shared per-request path inert without a license.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct AvailableApps {
    pub restricted: bool,
    pub providers: Vec<String>,
}

pub(crate) const POLICY_V2_SELECT: &str = r#"
    SELECT r.id, r.logical_id, r.name, r.source, r.priority, r.is_default, r.action,
           r.rate_limit, r.rate_limit_window, r.require_approval, r.conditions,
           COALESCE((
             SELECT json_agg(json_build_object(
               'agentId', i.agent_id,
               'userId', i.user_id, 'groupId', i.group_id))
             FROM policy_rule_identities i WHERE i.rule_id = r.id
           ), '[]'::json) AS identities,
           COALESCE((
             SELECT json_agg(json_build_object(
               'kind', t.kind, 'appProvider', t.app_provider, 'appTools', t.app_tools,
               'appConnectionScope', t.app_connection_scope,
               'appConnectionId', t.app_connection_id, 'secretId', t.secret_id,
               'secretScope', t.secret_scope,
               'hostPattern', t.host_pattern, 'pathPattern', t.path_pattern,
               'method', t.method))
             FROM policy_rule_targets t WHERE t.rule_id = r.id
           ), '[]'::json) AS targets
    FROM policy_rules_v2 r
"#;

/// Active published workspace-scope rules (max published generation), first-match
/// ordered.
pub(crate) async fn find_published_policy_rules_v2_by_workspace(
    pool: &PgPool,
    workspace_id: &str,
) -> Result<Vec<PolicyRuleV2Row>> {
    sqlx::query_as::<_, PolicyRuleV2Row>(&format!(
        r#"{POLICY_V2_SELECT}
           WHERE r.workspace_id = $1 AND r.scope = 'workspace'
             AND r.status = 'published' AND r.enabled = true
             AND r.generation = (
               SELECT max(generation) FROM policy_rules_v2
               WHERE workspace_id = $1 AND scope = 'workspace' AND status = 'published')
           ORDER BY r.priority, r.id"#
    ))
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .context("querying policy_rules_v2 by workspace_id")
}

#[derive(sqlx::FromRow)]
struct SecretHostRow {
    id: String,
    host_pattern: String,
    scope: String,
    #[sqlx(rename = "type")]
    type_: String,
    metadata: Option<serde_json::Value>,
}

/// Resolve the host patterns of the acting org+workspace custom secrets so the
/// block/allow engine can let a `secret` target permit/deny its host (step 8).
/// ORG+WORKSPACE-FENCED on every arm — a workspace secret via `workspace_id = $2` (a
/// workspace id is unique and belongs to one org, mirroring `find_secrets_by_workspace`),
/// an org secret via `organization_id = $1 AND scope = 'organization'` — so a
/// forged/foreign `secret_id` or scope can NEVER pull another org's host (it simply
/// isn't in the fenced set). Run once at connect (cached with `PolicyV2Rules`);
/// the per-request path never touches the DB.
pub(crate) async fn find_secret_hosts(
    pool: &PgPool,
    organization_id: &str,
    workspace_id: &str,
) -> Result<SecretHosts> {
    let rows: Vec<SecretHostRow> = sqlx::query_as::<_, SecretHostRow>(
        r#"
        SELECT id, host_pattern, scope, type, metadata FROM secrets
        WHERE workspace_id = $2
           OR (organization_id = $1 AND scope = 'organization')
        "#,
    )
    .bind(organization_id)
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .context("resolving secret hosts")?;

    let mut hosts = SecretHosts::default();
    for row in rows {
        // Expand each secret to EVERY host its credential injects on (an
        // OAuth-mode OpenAI secret covers several), so enforcement ⊇ injection.
        let patterns = crate::secret_inject::secret_host_patterns(
            &row.type_,
            &row.host_pattern,
            row.metadata.as_ref(),
        );
        match row.scope.as_str() {
            "workspace" => hosts.workspace_hosts.extend(patterns.iter().cloned()),
            "organization" => hosts.org_hosts.extend(patterns.iter().cloned()),
            _ => {}
        }
        hosts.by_id.insert(row.id, patterns);
    }
    Ok(hosts)
}

/// Resolve the providers of the acting org+workspace app connections so the
/// block/allow engine can decode a `connection` target to its provider's catalog
/// hosts (the secret symmetry). ORG+WORKSPACE-FENCED exactly like
/// `find_secret_hosts` — a workspace connection via `workspace_id = $2`, an org
/// connection via `organization_id = $1 AND scope = 'organization'` — so a
/// forged/foreign connection id can NEVER resolve (it simply isn't in the fenced
/// set → the target never matches). No status filter: the row's existence is the
/// reference (deletion cascades the target row away; this map only covers the
/// ~60s cache window). Run once at connect (cached with `PolicyV2Rules`); the
/// per-request path never touches the DB.
pub(crate) async fn find_connection_providers(
    pool: &PgPool,
    organization_id: &str,
    workspace_id: &str,
) -> Result<ConnectionProviders> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT id, provider FROM app_connections
        WHERE workspace_id = $2
           OR (organization_id = $1 AND scope = 'organization')
        "#,
    )
    .bind(organization_id)
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .context("resolving connection providers")?;

    Ok(ConnectionProviders {
        by_id: rows.into_iter().collect(),
    })
}

// ── App config queries (BYOC credentials) ─────────────────────────────

/// An app config row from the `app_configs` table.
#[derive(Debug, FromRow)]
pub(crate) struct AppConfigRow {
    pub settings: Option<serde_json::Value>,
    pub credentials: Option<String>,
}

/// Find an enabled BYOC app config for a workspace + provider.
pub(crate) async fn find_app_config(
    pool: &PgPool,
    workspace_id: &str,
    provider: &str,
) -> Result<Option<AppConfigRow>> {
    sqlx::query_as::<_, AppConfigRow>(
        r#"SELECT settings, credentials FROM app_configs
           WHERE workspace_id = $1 AND provider = $2 AND enabled = true
           LIMIT 1"#,
    )
    .bind(workspace_id)
    .bind(provider)
    .fetch_optional(pool)
    .await
    .context("querying app_config by workspace_id + provider")
}

/// Find an enabled org-level BYOC app config for an organization + provider.
///
/// Org-level app configs are writable only through the EE org surface
/// (`POST /v1/org/apps/:provider/config`); OSS has no way to create them, so
/// this lookup simply finds no rows there and degrades to `None`.
pub(crate) async fn find_app_config_by_org(
    pool: &PgPool,
    organization_id: &str,
    provider: &str,
) -> Result<Option<AppConfigRow>> {
    sqlx::query_as::<_, AppConfigRow>(
        r#"SELECT settings, credentials FROM app_configs
           WHERE organization_id = $1 AND provider = $2
             AND scope = 'organization' AND enabled = true
           LIMIT 1"#,
    )
    .bind(organization_id)
    .bind(provider)
    .fetch_optional(pool)
    .await
    .context("querying app_config by organization_id + provider")
}

/// Find the enabled BYOC app config that minted a specific connection, via the
/// provenance link `app_connections.app_config_id`.
///
/// A connection's OAuth refresh token is bound to the client that minted it, so
/// refresh must reuse exactly that config — even when the resolver's tier order
/// (workspace → org) would now select a different row. Returns `None` when the
/// link is null (env-minted, a no-config method, or pre-dating the link), or the
/// config has since been disabled/removed, or (defence-in-depth) points at a
/// different provider. The `provider` guard keeps a mislinked FK from ever
/// handing one provider's client secret to another provider's token endpoint;
/// every writer links same-provider by construction, so it only ever excludes
/// corrupt data. Shared across editions: workspace-tier links exist in OSS; org
/// rows simply never exist there.
pub(crate) async fn find_app_config_by_connection(
    pool: &PgPool,
    connection_id: &str,
    provider: &str,
) -> Result<Option<AppConfigRow>> {
    sqlx::query_as::<_, AppConfigRow>(
        r#"SELECT ac.settings, ac.credentials FROM app_configs ac
           JOIN app_connections c ON c.app_config_id = ac.id
           WHERE c.id = $1 AND ac.provider = $2 AND ac.enabled = true
           LIMIT 1"#,
    )
    .bind(connection_id)
    .bind(provider)
    .fetch_optional(pool)
    .await
    .context("querying app_config by connection provenance link")
}

// ── App connection queries ─────────────────────────────────────────────

/// An app connection row from the `app_connections` table.
#[derive(Debug, Clone, PartialEq, FromRow, serde::Serialize, serde::Deserialize)]
pub(crate) struct AppConnectionRow {
    pub id: String,
    pub provider: String,
    /// "organization" | "workspace" — the connection's level, so a step-8 app
    /// target scoped to "all connections at level L" can match by it.
    pub scope: String,
    pub credentials: Option<String>,
    pub label: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub session_policy: Option<serde_json::Value>,
}

/// Find all connected app connections for a given workspace.
pub(crate) async fn find_app_connections_by_workspace(
    pool: &PgPool,
    workspace_id: &str,
) -> Result<Vec<AppConnectionRow>> {
    sqlx::query_as::<_, AppConnectionRow>(
        r#"SELECT id, provider, scope, credentials, label, metadata, NULL::jsonb AS session_policy FROM app_connections WHERE workspace_id = $1 AND status = 'connected'"#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .context("querying app_connections by workspace_id")
}

/// Find all organization-level app connections.
pub(crate) async fn find_app_connections_by_org(
    pool: &PgPool,
    organization_id: &str,
) -> Result<Vec<AppConnectionRow>> {
    sqlx::query_as::<_, AppConnectionRow>(
        r#"SELECT id, provider, scope, credentials, label, metadata, NULL::jsonb AS session_policy
           FROM app_connections
           WHERE organization_id = $1 AND scope = 'organization' AND status = 'connected'"#,
    )
    .bind(organization_id)
    .fetch_all(pool)
    .await
    .context("querying app_connections by organization_id")
}

/// Update the encrypted credentials for an app connection (e.g., after token refresh).
pub(crate) async fn update_app_connection_credentials(
    pool: &PgPool,
    connection_id: &str,
    encrypted_credentials: &str,
) -> Result<()> {
    sqlx::query(r#"UPDATE app_connections SET credentials = $1 WHERE id = $2"#)
        .bind(encrypted_credentials)
        .bind(connection_id)
        .execute(pool)
        .await
        .context("updating app_connection credentials")?;
    Ok(())
}

// ── Vault connection queries ────────────────────────────────────────────

/// Find a vault connection for a workspace + provider pair.
pub(crate) async fn find_vault_connection(
    pool: &PgPool,
    workspace_id: &str,
    provider: &str,
) -> Result<Option<VaultConnectionRow>> {
    sqlx::query_as::<_, VaultConnectionRow>(
        r#"SELECT id, provider, name, status, connection_data FROM vault_connections WHERE workspace_id = $1 AND provider = $2 LIMIT 1"#,
    )
    .bind(workspace_id)
    .bind(provider)
    .fetch_optional(pool)
    .await
    .context("querying vault_connection by workspace_id + provider")
}

/// Upsert a vault connection (insert or update on workspace_id + provider conflict).
pub(crate) async fn upsert_vault_connection(
    pool: &PgPool,
    workspace_id: &str,
    provider: &str,
    status: &str,
    connection_data: Option<&serde_json::Value>,
) -> Result<()> {
    sqlx::query(
        r#"INSERT INTO vault_connections (id, workspace_id, provider, status, connection_data, created_at, updated_at)
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (workspace_id, provider)
           DO UPDATE SET status = $3, connection_data = $4, updated_at = NOW()"#,
    )
    .bind(workspace_id)
    .bind(provider)
    .bind(status)
    .bind(connection_data)
    .execute(pool)
    .await
    .context("upserting vault_connection")?;
    Ok(())
}

/// Update only the connection_data JSON for an existing vault connection.
pub(crate) async fn update_vault_connection_data(
    pool: &PgPool,
    workspace_id: &str,
    provider: &str,
    connection_data: &serde_json::Value,
) -> Result<()> {
    sqlx::query(
        r#"UPDATE vault_connections SET connection_data = $3, updated_at = NOW() WHERE workspace_id = $1 AND provider = $2"#,
    )
    .bind(workspace_id)
    .bind(provider)
    .bind(connection_data)
    .execute(pool)
    .await
    .context("updating vault_connection connection_data")?;
    Ok(())
}

/// Delete a vault connection for a workspace + provider pair.
pub(crate) async fn delete_vault_connection(
    pool: &PgPool,
    workspace_id: &str,
    provider: &str,
) -> Result<()> {
    sqlx::query(r#"DELETE FROM vault_connections WHERE workspace_id = $1 AND provider = $2"#)
        .bind(workspace_id)
        .bind(provider)
        .execute(pool)
        .await
        .context("deleting vault_connection")?;
    Ok(())
}
