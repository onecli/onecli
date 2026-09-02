//! Shared shapes for the shadow policy engine: the old-model row + request +
//! the normalized decision, and the internal new-model rule the evaluator walks.
//!
//! Mirrors `packages/api/src/services/policy-translation/types.ts`. The two
//! implementations MUST produce identical decisions from identical inputs — the
//! shared golden corpus (`corpus_test.rs`) proves it. Network-verbatim only:
//! there is no `app`/`connection`/`secret` target and no group/user identity
//! here (§7.7 — the gateway is metadata-blind, so app rules reduce to the
//! network case; groups/resources arrive with steps 5–7).

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Scope {
    Organization,
    Workspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Action {
    Allow,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum RateWindow {
    Minute,
    Hour,
    Day,
}

/// The request context the evaluator decides against. Body is threaded
/// separately (as raw bytes, matching `policy::condition_match::matches`), not on this
/// struct — see `evaluate`.
#[derive(Debug, Clone)]
pub(super) struct PolicyRequest {
    pub host: String,
    pub path: String,
    pub method: String,
    pub agent_id: String,
    /// The requesting agent's resolved principal set (step 6): the human users +
    /// directory groups its workspace inherits via WorkspaceAccess. Resolved once at
    /// connect (never per request); a `User`/`Group` rule identity matches iff it
    /// is in the matching set. Empty for pure-agent traffic (and always in OSS)
    /// → only `Agent`/"any" rules can match.
    pub user_ids: Vec<String>,
    pub group_ids: Vec<String>,
    /// A credential was injected for this host — the deny-default precondition.
    pub has_injections: bool,
    /// Host is a known LLM provider — bypasses deny-default.
    pub is_llm_host: bool,
    /// The app connection that won injection for this request; `None` when no
    /// connection serves it (uncredentialed, secret-served, vault, or the
    /// non-serving wipe). `Target::Connection` matches only against this id.
    pub winning_connection_id: Option<String>,
}

impl PolicyRequest {
    /// The deny-default carve: only credentialed, non-LLM traffic can be blocked
    /// by a Default Rule (either level's). Mirrors `forward.rs`'s `enforce_deny`.
    pub(super) fn enforce_deny(&self) -> bool {
        self.has_injections && !self.is_llm_host
    }
}

/// The normalized decision the corpus/parity tests assert against — the first-match
/// engine's `evaluate_new` collapses an `Outcome` to this (the live enforce path
/// uses the richer `PolicyDecision`). Test-only. `#[serde(default)]` on the bool
/// fields mirrors the corpus (absent = false); `Option` fields are `None` when absent.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Decision {
    pub action: Action,
    // `#[serde(default)]` is needed on the bool fields (absent = false); the
    // `Option` fields are implicitly `None` when absent.
    #[serde(default)]
    pub require_approval: bool,
    pub rate_limit: Option<u64>,
    pub rate_limit_window: Option<RateWindow>,
    #[serde(default)]
    pub by_default: bool,
}

#[cfg(test)]
impl Decision {
    pub(super) fn block() -> Self {
        Self {
            action: Action::Block,
            require_approval: false,
            rate_limit: None,
            rate_limit_window: None,
            by_default: false,
        }
    }
    pub(super) fn allow() -> Self {
        Self {
            action: Action::Allow,
            require_approval: false,
            rate_limit: None,
            rate_limit_window: None,
            by_default: false,
        }
    }
    pub(super) fn allow_approval() -> Self {
        Self {
            action: Action::Allow,
            require_approval: true,
            rate_limit: None,
            rate_limit_window: None,
            by_default: false,
        }
    }
    pub(super) fn allow_rate(limit: u64, window: RateWindow) -> Self {
        Self {
            action: Action::Allow,
            require_approval: false,
            rate_limit: Some(limit),
            rate_limit_window: Some(window),
            by_default: false,
        }
    }
    pub(super) fn block_by_default() -> Self {
        Self {
            action: Action::Block,
            require_approval: false,
            rate_limit: None,
            rate_limit_window: None,
            by_default: true,
        }
    }
}

// ── Internal new-model shapes for the evaluator ──────────────────────────────

/// A rule identity. `Agent` matches the requesting agent by id; the directory
/// kinds (step 6) match against the connection's resolved principal set —
/// `User`/`Group` ∈ the request's `user_ids`/`group_ids`. Empty `identities`
/// on a rule = "any". `Unresolved` is the fail-safe for a row with no
/// principal (the DB `one_principal` CHECK makes this unreachable) — it never
/// matches, so a malformed rule can't silently widen to "any".
#[derive(Debug, Clone)]
pub(super) enum Identity {
    Agent(String),
    User(String),
    Group(String),
    Unresolved,
}

/// A rule target. `Network` matches host/path/method verbatim; `App` names a
/// provider and tool set the catalog re-expands to the same network fan-out
/// (§7.7) — or, with NO tools, the whole app: host-only against every catalog
/// tool host of the provider; `Connection` binds one specific connection —
/// winner-id equality plus the same catalog expansion; `Secret` gates its
/// resolved host(s) (step 8). The translator (step-4 shadow / corpus) only
/// emits `Network`; the live v2 assembler emits all four.
#[derive(Debug, Clone)]
pub(super) enum Target {
    Network {
        host_pattern: String,
        path_pattern: Option<String>,
        method: Option<String>,
    },
    /// An app-permission target. Non-empty `tools` → the exact per-tool
    /// (host, path, method) fan-out. EMPTY `tools` → the whole app: matches
    /// host-only against ALL the provider's catalog tool hosts — permit on an
    /// allow rule, block on a block rule, symmetric with `Secret`. Authored as
    /// the dialog's "All connections" shape. An unknown/catalog-less provider
    /// matches nothing (fail-closed).
    App {
        provider: String,
        tools: Vec<String>,
    },
    /// A specific app connection: matches only when it is the request's winning
    /// injected connection AND the provider/tools catalog fan-out hits (the
    /// same expansion as `App`; empty `tools` = the connection's whole app,
    /// host-only). A request with no winning connection (uncredentialed,
    /// secret-served, or the non-serving wipe) never matches — fail-closed for
    /// allow AND block.
    Connection {
        id: String,
        provider: String,
        tools: Vec<String>,
    },
    /// A `secret` target resolved (at connect) to its credential's host
    /// pattern(s): a specific secret → its one host; a level scope → the union of
    /// the org/workspace secrets' hosts. It gates traffic by host — permit on an
    /// allow rule (and inject at connect), block on a block rule — symmetric with an
    /// `App` target. Empty = the secret couldn't be resolved (e.g. deleted) → never
    /// matches (fail-closed).
    Secret { host_patterns: Vec<String> },
    /// A target the block/allow engine can't resolve: an unknown kind, a
    /// provider-less app row, or a `connection` target whose connection is absent
    /// from the fenced connect-time map (deleted in the cache window, or a
    /// forged/foreign id the fence excluded). Never matches (fail-closed).
    Unresolved,
}

/// A new-model rule the evaluator walks. `priority` orders per-level first-match;
/// empty `identities`/`targets` = "any" (a Default Rule). `id`/`name` carry
/// the source rule's identifiers so the live decision can surface
/// `Blocked{rule_name}` / `ManualApproval{rule_id}` (the corpus/shadow path leaves
/// them empty — it only asserts the normalized `Decision`). Mirrors `NewRule` in
/// types.ts.
#[derive(Debug, Clone)]
pub(super) struct NewRule {
    pub id: String,
    /// Generation-stable identity for the rate counter (see PolicyRuleV2Row).
    pub logical_id: String,
    pub name: String,
    pub scope: Scope,
    pub priority: usize,
    pub is_default: bool,
    pub identities: Vec<Identity>,
    pub targets: Vec<Target>,
    pub action: Action,
    pub require_approval: bool,
    pub rate_limit: Option<u64>,
    pub rate_limit_window: Option<RateWindow>,
    pub conditions: Option<serde_json::Value>,
}

/// Strictness rank shared by the translator (priority assignment) and the
/// evaluator (first-match ordering + level combine): block strictest (0) …
/// allow loosest (3), reproducing Block > ManualApproval > RateLimit > Allow.
/// Mirrors strictness.ts — the two consumers MUST agree.
pub(super) fn strictness_rank(rule: &NewRule) -> u8 {
    if rule.action == Action::Block {
        return 0;
    }
    if rule.require_approval {
        return 1;
    }
    if rule.rate_limit.is_some() {
        return 2;
    }
    3
}
