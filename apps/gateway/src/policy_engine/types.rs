//! Shapes for the OSS project-level policy core: the decoded rule, the request
//! context, and the evaluation outcome. Project scope only — OSS has no org
//! layer, no directory identities, and no granular conditions; those live in
//! the EE engine this module replaces under `edition_oss`.

/// The rule verdict: the v2 binary. Approval and rate limits are modifiers on
/// `Allow` (see `Rule`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Action {
    Allow,
    Block,
}

/// A rate-limit window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RateWindow {
    Minute,
    Hour,
    Day,
}

impl RateWindow {
    pub(super) fn secs(self) -> u64 {
        match self {
            RateWindow::Minute => 60,
            RateWindow::Hour => 3600,
            RateWindow::Day => 86400,
        }
    }
}

/// A rule identity. OSS rules target a specific agent or all agents (empty
/// identity list = "any"). `Other` covers every non-agent identity row a
/// permissive API client might have stored (agent-group/user/group are OneCLI
/// Cloud capabilities) — it NEVER matches, so such a row narrows to nothing
/// instead of silently widening to "any" (fail-closed).
#[derive(Debug, Clone)]
pub(super) enum Identity {
    Agent(String),
    Other,
}

/// A rule target. `Network` matches host/path/method verbatim; `App` names a
/// provider and tool set the catalog expands to its endpoint fan-out (empty
/// tools = the whole app, host-only); `Secret` gates its resolved host
/// pattern(s); `Unresolved` is the fail-closed arm for anything that cannot be
/// resolved (unknown kind, provider-less app row, a connection/secret id absent
/// from the fenced connect-time maps) — it never matches.
#[derive(Debug, Clone)]
pub(super) enum Target {
    Network {
        host_pattern: String,
        path_pattern: Option<String>,
        method: Option<String>,
    },
    App {
        provider: String,
        tools: Vec<String>,
    },
    Secret {
        host_patterns: Vec<String>,
    },
    Unresolved,
}

/// A decoded project rule the evaluator walks. No `scope` field — everything
/// here is project scope (`MatchedRule.scope` is the constant "project").
#[derive(Debug, Clone)]
pub(super) struct Rule {
    pub id: String,
    /// Generation-stable identity — the shared rate counter keys on it, so the
    /// count survives republishes.
    pub logical_id: String,
    pub name: String,
    pub priority: usize,
    pub is_default: bool,
    pub identities: Vec<Identity>,
    pub targets: Vec<Target>,
    pub action: Action,
    pub require_approval: bool,
    pub rate_limit: Option<u64>,
    pub rate_limit_window: Option<RateWindow>,
    /// Carried for structural fidelity and routed through the edition-swapped
    /// `condition_match` — which is the no-op arm in OSS, so conditions are
    /// never evaluated here (matching the legacy OSS gateway exactly).
    pub conditions: Option<serde_json::Value>,
}

/// The request context one decision runs against. `host` is port-stripped by
/// the caller.
#[derive(Debug, Clone)]
pub(super) struct Request {
    pub host: String,
    pub path: String,
    pub method: String,
    pub agent_id: String,
    /// A credential was injected for this host — the deny-default precondition.
    pub has_injections: bool,
    /// Host is a known LLM provider — bypasses deny-default.
    pub is_llm_host: bool,
}

impl Request {
    /// The deny-default carve: only credentialed, non-LLM traffic can be
    /// blocked by the Default Rule. Mirrors `forward.rs`'s `enforce_deny`.
    pub(super) fn enforce_deny(&self) -> bool {
        self.has_injections && !self.is_llm_host
    }
}

/// The winning outcome of an evaluation: an explicit matching rule, the
/// project Default Rule's enforced Block (carrying THAT rule, so telemetry can
/// attribute it — always concrete, never anonymous), or a plain allow.
pub(super) enum Outcome<'a> {
    Rule(&'a Rule),
    DenyDefault(&'a Rule),
    Allow,
}
