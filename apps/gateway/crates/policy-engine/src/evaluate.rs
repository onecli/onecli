//! The first-match policy engine (mirrors evaluator.ts).
//!
//! Two-level: per-scope first-match (org, then workspace), combined by strictest,
//! with each level's Default Rule as its fallback verdict (deny wins). Splitting
//! the levels and combining by strictest lets a WORKSPACE agent-scoped rule shadow
//! (loosen or tighten) a workspace all-agents rule, while NEVER letting a workspace
//! rule override an org rule — first-match ranks agent-scoped rules above
//! all-agents rules within the workspace level via priority.
//!
//! The per-rule network MATCH routes through the gateway's own
//! `connect::host_matches` + `policy::matches_request`, so matching is
//! byte-identical to the live path (path glob, method, conditions, and the
//! git-receive-pack bridge).

use policy::{matches_request, ConditionBody, PolicyAction, PolicyRule};

#[cfg(test)]
use super::types::Decision;
use super::types::{strictness_rank, Action, Identity, NewRule, PolicyRequest, Scope, Target};

fn identity_matches(rule: &NewRule, request: &PolicyRequest) -> bool {
    rule.identities.is_empty()
        || rule.identities.iter().any(|i| match i {
            Identity::Agent(id) => *id == request.agent_id,
            Identity::User(id) => request.user_ids.contains(id),
            Identity::Group(id) => request.group_ids.contains(id),
            Identity::Unresolved => false,
        })
}

/// Build a throwaway `policy::PolicyRule` so the network match routes through the
/// gateway's exact `matches_request`. `action` must be the owning rule's
/// POLARITY (`polarity_of`), not a placeholder: it decides how an UNKNOWN
/// body-condition result on a truncated body resolves (#999) — restrictive
/// rules match (fail closed), permissive rules don't.
fn pseudo_rule(
    path_pattern: Option<&str>,
    method: Option<String>,
    conditions: &Option<serde_json::Value>,
    action: PolicyAction,
) -> PolicyRule {
    PolicyRule {
        name: String::new(),
        path_pattern: path_pattern.unwrap_or("*").to_string(),
        method,
        action,
        conditions_raw: conditions.clone(),
    }
}

/// The rule's truncation polarity as a `policy::PolicyAction`: restrictive
/// (Block / approval / rate-limit — exactly `strictness_rank < 3`) → `Block`,
/// plain allow → `Allow`. Threaded into every throwaway matcher rule so
/// `condition_match::matches` can fail closed on a truncated body.
fn polarity_of(rule: &NewRule) -> PolicyAction {
    if strictness_rank(rule) < 3 {
        PolicyAction::Block
    } else {
        PolicyAction::Allow
    }
}

fn target_matches(
    target: &Target,
    rule: &NewRule,
    request: &PolicyRequest,
    body: ConditionBody<'_>,
) -> bool {
    match target {
        Target::Network {
            host_pattern,
            path_pattern,
            method,
        } => {
            common::util::host_matches(&request.host, host_pattern)
                && matches_request(
                    &pseudo_rule(
                        path_pattern.as_deref(),
                        method.clone(),
                        &rule.conditions,
                        polarity_of(rule),
                    ),
                    &request.method,
                    &request.path,
                    body,
                )
        }
        Target::App { provider, tools } => super::catalog::app_target_matches(
            provider,
            tools,
            &request.host,
            &request.method,
            &request.path,
            body,
            &rule.conditions,
            polarity_of(rule),
        ),
        // A connection target binds to the account that won injection: it
        // matches only when this request's winning injected connection is
        // exactly this one AND the provider/tools fan-out hits (the same
        // expansion as `App`). No winner (uncredentialed, secret-served, or the
        // non-serving wipe) → never matches — fail-closed for allow AND block.
        Target::Connection {
            id,
            provider,
            tools,
        } => {
            request.winning_connection_id.as_deref() == Some(id.as_str())
                && super::catalog::app_target_matches(
                    provider,
                    tools,
                    &request.host,
                    &request.method,
                    &request.path,
                    body,
                    &rule.conditions,
                    polarity_of(rule),
                )
        }
        // A secret gates its host: it matches when the request host matches ANY of
        // the secret's resolved host patterns (host-only, mirroring the connect-time
        // injection filter so permit ⟺ inject). `request.host` is already
        // port-stripped (the policy host), so `host_matches` needs no extra strip.
        // Empty patterns (unresolved/deleted secret) → never matches (fail-closed).
        Target::Secret { host_patterns } => host_patterns
            .iter()
            .any(|h| common::util::host_matches(&request.host, h)),
        Target::Unresolved => false,
    }
}

fn rule_matches(rule: &NewRule, request: &PolicyRequest, body: ConditionBody<'_>) -> bool {
    // A non-default rule matches only when it names at least one target AND one of
    // them matches. Empty targets = matches NOTHING (fail-closed): "match every
    // request" is the Default Rule's terminal job or an explicit network wildcard,
    // never an empty target list. This also neutralizes an orphaned rule whose only
    // connection/secret target was deleted (the FK cascade leaves it with zero
    // targets) — it goes inert instead of silently matching everything. Only
    // non-default rules reach here (`first_match` skips the default, whose "any" is
    // its level's default fallback), so the terminal Default Rules are unaffected.
    identity_matches(rule, request)
        && !rule.targets.is_empty()
        && rule
            .targets
            .iter()
            .any(|t| target_matches(t, rule, request, body))
}

struct LevelMatch<'a> {
    rank: u8,
    rule: &'a NewRule,
}

/// First matching rule in priority order within one scope.
fn first_match<'a>(
    rules: &[&'a NewRule],
    request: &PolicyRequest,
    body: ConditionBody<'_>,
) -> Option<LevelMatch<'a>> {
    let mut ordered: Vec<&'a NewRule> = rules.to_vec();
    // Priority, then id: a total, deterministic order even if two rules share a
    // priority (mirrors the TS evaluator + `ORDER BY r.priority, r.id`). `id` is a
    // lowercase-hex UUID, so Rust byte order == Postgres `ORDER BY id` collation —
    // the two ports agree on ties; a mixed-case PK format would break that.
    ordered.sort_by(|a, b| a.priority.cmp(&b.priority).then_with(|| a.id.cmp(&b.id)));
    for rule in ordered {
        if rule_matches(rule, request, body) {
            return Some(LevelMatch {
                rank: strictness_rank(rule),
                rule,
            });
        }
    }
    None
}

#[cfg(test)]
fn to_decision(rule: &NewRule) -> Decision {
    if rule.action == Action::Block {
        return Decision::block();
    }
    if rule.require_approval {
        return Decision::allow_approval();
    }
    match (rule.rate_limit, rule.rate_limit_window) {
        (Some(limit), Some(window)) => Decision::allow_rate(limit, window),
        _ => Decision::allow(),
    }
}

/// The winning outcome of a first-match evaluation: a concrete rule, a
/// deny-default (either level's Default Rule Block, when enforced — carrying
/// THAT Default Rule so telemetry can attribute it, org-first when both
/// block), or a plain allow. The live enforce path needs the winning RULE
/// (its id/name + rate modifier); the corpus/materialization path collapses
/// it to a `Decision`.
pub(super) enum Outcome<'a> {
    Rule(&'a NewRule),
    DenyDefault(Option<&'a NewRule>),
    Allow,
}

/// The uniform per-level default law (step 9): each level's verdict is its
/// first matching rule, else its Default Rule; the stricter verdict wins
/// (deny-wins). A level with no rules and no Default Rule contributes no
/// verdict. Default-Block verdicts are gated by the `enforce_deny` carve
/// (managed, non-LLM requests only); explicit rule blocks are unconditional.
/// Mirrors evaluateNew.
pub(super) fn evaluate_outcome<'a>(
    rules: &'a [NewRule],
    request: &PolicyRequest,
    body: ConditionBody<'_>,
) -> Outcome<'a> {
    let org_explicit: Vec<&NewRule> = rules
        .iter()
        .filter(|r| !r.is_default && r.scope == Scope::Organization)
        .collect();
    let workspace_explicit: Vec<&NewRule> = rules
        .iter()
        .filter(|r| !r.is_default && r.scope == Scope::Workspace)
        .collect();

    let org_match = first_match(&org_explicit, request, body);
    let workspace_match = first_match(&workspace_explicit, request, body);

    // A Default Rule Block is a HARD FLOOR at its level: the org default's Block
    // may not be opened by a workspace ALLOW (only an org allow rule or an org
    // allow posture opens the door), and symmetrically a workspace default Block
    // (allowlist mode) may not be opened by an org ALLOW — an org allow is
    // "permission"; the workspace mirrors the allows it wants. Computed up front
    // so the one-sided match arms can defer to them.
    let org_default = rules
        .iter()
        .find(|r| r.is_default && r.scope == Scope::Organization);
    let org_default_blocks =
        org_default.is_some_and(|d| d.action == Action::Block && request.enforce_deny());
    let workspace_default = rules
        .iter()
        .find(|r| r.is_default && r.scope == Scope::Workspace);
    let workspace_default_blocks =
        workspace_default.is_some_and(|d| d.action == Action::Block && request.enforce_deny());

    // Combine by strictest (lower rank = stricter); on a tie keep the org match
    // so the org rate modifier wins, matching the oracle's org-first Pass 3.
    let best = match (org_match, workspace_match) {
        (Some(o), Some(p)) => Some(if p.rank < o.rank { p } else { o }),
        // A lone org ALLOW can't punch through the workspace default Block
        // (allowlist mode) — defer to the deny-default below. An org BLOCK still
        // applies (it only tightens). Approval/rate rules are Action::Allow, so
        // they defer too — symmetric with the org-floor arm below.
        (Some(o), None) if o.rule.action == Action::Allow && workspace_default_blocks => None,
        (Some(o), None) => Some(o),
        // A lone workspace ALLOW can't punch through the org default Block (the hard
        // floor) — defer to the deny-default below. A workspace BLOCK still applies
        // (it only tightens), and an allow-posture org lets the workspace allow win.
        (None, Some(p)) if p.rule.action == Action::Allow && org_default_blocks => None,
        (None, Some(p)) => Some(p),
        (None, None) => None,
    };
    if let Some(m) = best {
        return Outcome::Rule(m.rule);
    }

    // No explicit rule survived → the level defaults decide; deny wins.
    // Attribution is org-first (the org default is the outer floor).
    if org_default_blocks {
        return Outcome::DenyDefault(org_default);
    }
    if workspace_default_blocks {
        return Outcome::DenyDefault(workspace_default);
    }
    Outcome::Allow
}

/// Decide `request` against a rule set, collapsed to a normalized `Decision` — the
/// cross-port corpus parity path (the live enforce path uses `evaluate` →
/// `PolicyDecision`). Mirrors evaluateNew. Test-only since the shadow was retired.
#[cfg(test)]
pub(super) fn evaluate_new(
    rules: &[NewRule],
    request: &PolicyRequest,
    body: ConditionBody<'_>,
) -> Decision {
    match evaluate_outcome(rules, request, body) {
        Outcome::Rule(rule) => to_decision(rule),
        Outcome::DenyDefault(_) => Decision::block_by_default(),
        Outcome::Allow => Decision::allow(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal non-default workspace rule that matches `request()` — empty
    /// identities ("any") + a `Network` target on the request host.
    fn matching_rule(id: &str, priority: usize, action: Action) -> NewRule {
        NewRule {
            id: id.to_string(),
            logical_id: id.to_string(),
            name: String::new(),
            scope: Scope::Workspace,
            priority,
            is_default: false,
            identities: Vec::new(),
            targets: vec![Target::Network {
                host_pattern: "api.example.com".to_string(),
                path_pattern: None,
                method: None,
            }],
            action,
            require_approval: false,
            rate_limit: None,
            rate_limit_window: None,
            conditions: None,
        }
    }

    fn request() -> PolicyRequest {
        PolicyRequest {
            host: "api.example.com".to_string(),
            path: "/x".to_string(),
            method: "GET".to_string(),
            agent_id: "agent-1".to_string(),
            user_ids: Vec::new(),
            group_ids: Vec::new(),
            has_injections: false,
            is_llm_host: false,
            winning_connection_id: None,
        }
    }

    /// Two rules sharing a priority resolve by `id` (lower first), NOT by
    /// insertion/DB-row order — so first-match is deterministic and agrees with
    /// `ORDER BY r.priority, r.id` and the TS evaluator. The reversed-order case
    /// is the one that would fail under the old stable `sort_by_key(priority)`.
    #[test]
    fn equal_priority_first_match_is_deterministic_by_id() {
        let a = matching_rule("a", 5, Action::Allow);
        let b = matching_rule("b", 5, Action::Block);
        let req = request();

        let ab = first_match(&[&a, &b], &req, ConditionBody::None).expect("a matches");
        assert_eq!(ab.rule.id, "a", "lower id wins");

        let ba = first_match(&[&b, &a], &req, ConditionBody::None).expect("a matches");
        assert_eq!(
            ba.rule.id, "a",
            "reversed insertion order still picks the lower id"
        );
    }

    /// A conditioned rule the request would need the body's TAIL to decide.
    fn conditioned_rule(id: &str, action: Action) -> NewRule {
        let mut rule = matching_rule(id, 5, action);
        rule.conditions = Some(serde_json::json!([
            { "target": "body", "operator": "contains", "value": "wire-transfer" }
        ]));
        rule
    }

    /// The truncation polarity law (#999), proven at the ENGINE level — the
    /// full first-match pipeline (rule_matches → target_matches → pseudo_rule
    /// → condition_match), not just the condition matcher: on a truncated
    /// prefix that does NOT carry the value, a Block decides Block (fail
    /// closed) while an Allow does not match at all (nothing granted on
    /// unseen bytes).
    #[test]
    fn truncated_body_polarity_holds_through_the_engine() {
        let req = request();
        let prefix = ConditionBody::Truncated(b"an innocuous prefix");

        assert_eq!(
            evaluate_new(&[conditioned_rule("b1", Action::Block)], &req, prefix),
            Decision::block(),
            "restrictive rule must decide Block on a truncated miss"
        );
        assert_eq!(
            evaluate_new(&[conditioned_rule("a1", Action::Allow)], &req, prefix),
            Decision::allow(),
            "the Allow must NOT match (falls through to a plain allow — under \
             a deny-default it would then be blocked, never granted)"
        );

        // A definite hit in the prefix matches for BOTH polarities.
        let hit = ConditionBody::Truncated(b"initiate a wire-transfer now");
        assert_eq!(
            evaluate_new(&[conditioned_rule("b1", Action::Block)], &req, hit),
            Decision::block()
        );

        // On the FULL body the same miss is a definite non-match — the
        // fail-closed arm never fires on a complete body.
        assert_eq!(
            evaluate_new(
                &[conditioned_rule("b1", Action::Block)],
                &req,
                ConditionBody::Full(b"an innocuous prefix")
            ),
            Decision::allow(),
            "a complete body without the value must not block"
        );
    }

    /// The load-bearing consequence of the Allow polarity: in allowlist mode
    /// (deny-default), a truncated miss on the Allow's condition means the
    /// Allow does not match and the DEFAULT BLOCK decides — the request is
    /// refused, never granted on unseen bytes. Both polarities are fail-closed.
    #[test]
    fn truncated_allow_condition_falls_to_the_deny_default() {
        let mut default_block = matching_rule("zz-default", 999, Action::Block);
        default_block.is_default = true;
        default_block.targets = Vec::new();
        let rules = [conditioned_rule("a1", Action::Allow), default_block];

        // The deny-default carve requires credentialed, non-LLM traffic.
        let mut req = request();
        req.has_injections = true;

        assert_eq!(
            evaluate_new(&rules, &req, ConditionBody::Truncated(b"innocuous")),
            Decision::block_by_default(),
            "allowlist mode: a truncated miss must fall to the default Block"
        );
        assert_eq!(
            evaluate_new(&rules, &req, ConditionBody::Full(b"has wire-transfer")),
            Decision::allow(),
            "the same allow still works on a full body that carries the value"
        );
    }
}
