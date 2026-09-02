//! The shared golden corpus: each case authors an assembled
//! `NewRule` set and asserts the first-match engine (`evaluate_new`, the surviving
//! path) reproduces the expected decision, over the SAME JSON the TypeScript
//! `policy-translation` golden-corpus block runs through its `evaluateNew` (single
//! source of truth, §7.1) — so the two ports stay locked to one hand-computed
//! `expected`, now independent of the retired old→new translators. (The
//! `documented_divergence_*` tests below still exercise the old translator/oracle;
//! they retire with it in step 10's gateway workstream.)

use serde::Deserialize;

use super::evaluate::{evaluate_new, evaluate_outcome, Outcome};
use super::types::{Action, Decision, Identity, NewRule, PolicyRequest, RateWindow, Scope, Target};
use policy::ConditionBody;

// The corpus lives in the API package (the TS spec's home). `include_str!`
// resolves relative to this file
// (apps/gateway/crates/policy-engine/src/), so five `..` reach
// the repo root. Coupling the gateway test build (this module is
// `#[cfg(test)]`) to the shared file is intentional — a byte-identical single
// source of truth for both engines.
const CORPUS: &str = include_str!(
    "../../../../../packages/api/src/services/policy-translation/corpus/policy-cases.json"
);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    rules: Vec<CorpusRule>,
    request: CorpusRequest,
    expected: Decision,
}

// A test-only deserialize shim for a v2 `NewRule`: the engine `NewRule`/`Target`/
// `Identity` deliberately aren't `Deserialize` (the JSON boundary stays out of the
// engine), so the corpus mirrors the `NewRule` interface in types.ts here and
// converts. `source`/`name` are present in the JSON but the evaluator ignores
// `source`, and `id`/`logicalId` are synthesized (the corpus asserts the
// normalized `Decision` only).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusRule {
    scope: Scope,
    priority: usize,
    is_default: bool,
    #[serde(default)]
    name: String,
    identities: Vec<CorpusIdentity>,
    targets: Vec<CorpusTarget>,
    action: Action,
    #[serde(default)]
    require_approval: bool,
    rate_limit: Option<u64>,
    rate_limit_window: Option<RateWindow>,
    conditions: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum CorpusIdentity {
    Agent { id: String },
    User { id: String },
    Group { id: String },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum CorpusTarget {
    Network {
        host_pattern: String,
        path_pattern: Option<String>,
        method: Option<String>,
    },
    App {
        provider: String,
        #[serde(default)]
        tools: Vec<String>,
    },
    // A RESOLVED connection target (the corpus authors the post-assemble
    // shape): binds to the request's winning injected connection. The JSON
    // field is `connectionId`, mirroring the TS `NewTarget`.
    Connection {
        #[serde(rename = "connectionId")]
        id: String,
        provider: String,
        #[serde(default)]
        tools: Vec<String>,
    },
    Secret {
        host_patterns: Vec<String>,
    },
}

impl CorpusRule {
    fn into_new_rule(self) -> NewRule {
        NewRule {
            id: String::new(),
            logical_id: String::new(),
            name: self.name,
            scope: self.scope,
            priority: self.priority,
            is_default: self.is_default,
            identities: self
                .identities
                .into_iter()
                .map(|i| match i {
                    CorpusIdentity::Agent { id } => Identity::Agent(id),
                    CorpusIdentity::User { id } => Identity::User(id),
                    CorpusIdentity::Group { id } => Identity::Group(id),
                })
                .collect(),
            targets: self
                .targets
                .into_iter()
                .map(|t| match t {
                    CorpusTarget::Network {
                        host_pattern,
                        path_pattern,
                        method,
                    } => Target::Network {
                        host_pattern,
                        path_pattern,
                        method,
                    },
                    CorpusTarget::App { provider, tools } => Target::App { provider, tools },
                    CorpusTarget::Connection {
                        id,
                        provider,
                        tools,
                    } => Target::Connection {
                        id,
                        provider,
                        tools,
                    },
                    CorpusTarget::Secret { host_patterns } => Target::Secret { host_patterns },
                })
                .collect(),
            action: self.action,
            require_approval: self.require_approval,
            rate_limit: self.rate_limit,
            rate_limit_window: self.rate_limit_window,
            conditions: self.conditions,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusRequest {
    host: String,
    path: String,
    method: String,
    agent_id: String,
    // The agent's resolved principal set (step 6). Optional so the existing
    // agent-only cases parse unchanged (absent → empty → only agent/"any" match).
    #[serde(default)]
    user_ids: Vec<String>,
    #[serde(default)]
    group_ids: Vec<String>,
    has_injections: bool,
    is_llm_host: bool,
    // The app connection that won injection (per-connection decisions).
    // Optional so pre-existing cases parse unchanged (absent → None → a
    // `Connection` target never matches).
    #[serde(default)]
    winning_connection_id: Option<String>,
    body: Option<String>,
}

/// Drift guard for the org-empty reduction invariant. The engine's two-level
/// evaluator must reduce exactly to its workspace arm when a case carries no org
/// rules and no directory principals — that used to be proven by a separate
/// parity fence against the deleted OSS core; with one engine it is implied by
/// `corpus_engine_matches_expected` covering these cases with empty org input.
/// Pin the slice sizes so a corpus change that erodes the workspace-only
/// coverage (or the conditioned coverage inside it) is a loud prompt to
/// re-check, not a silent narrowing.
#[test]
fn corpus_keeps_the_workspace_only_reduction_slice() {
    let cases: Vec<Case> = serde_json::from_str(CORPUS).expect("parse policy-cases.json");
    let workspace_only: Vec<&Case> = cases
        .iter()
        .filter(|c| {
            c.rules.iter().all(|r| {
                r.scope == Scope::Workspace
                    && r.identities
                        .iter()
                        .all(|i| matches!(i, CorpusIdentity::Agent { .. }))
                    && r.targets
                        .iter()
                        .all(|t| matches!(t, CorpusTarget::Network { .. }))
            })
        })
        .collect();
    assert_eq!(workspace_only.len(), 13, "workspace-only slice drifted");
    let conditioned = workspace_only
        .iter()
        .filter(|c| {
            c.rules.iter().any(|r| match &r.conditions {
                Some(serde_json::Value::Array(a)) => !a.is_empty(),
                Some(serde_json::Value::Null) | None => false,
                Some(_) => true,
            })
        })
        .count();
    assert_eq!(conditioned, 2, "conditioned workspace-only slice drifted");
}

#[test]
fn corpus_engine_matches_expected() {
    let cases: Vec<Case> = serde_json::from_str(CORPUS).expect("parse policy-cases.json");
    assert_eq!(cases.len(), 42, "corpus case count changed");

    for case in cases {
        let request = PolicyRequest {
            host: case.request.host,
            path: case.request.path,
            method: case.request.method,
            agent_id: case.request.agent_id,
            user_ids: case.request.user_ids,
            group_ids: case.request.group_ids,
            has_injections: case.request.has_injections,
            is_llm_host: case.request.is_llm_host,
            winning_connection_id: case.request.winning_connection_id,
        };
        let body = case
            .request
            .body
            .as_deref()
            .map(|b| ConditionBody::Full(b.as_bytes()))
            .unwrap_or(ConditionBody::None);
        // Author the assembled v2 rules directly (decode/assemble is covered by the
        // `assemble` tests) and run the SURVIVING first-match evaluator — the same
        // `evaluate_new` the live enforce path calls. The TS `policy-translation`
        // golden-corpus block runs the SAME JSON through its `evaluateNew`, so the
        // two ports stay locked to one hand-computed `expected`.
        let rules: Vec<NewRule> = case
            .rules
            .into_iter()
            .map(CorpusRule::into_new_rule)
            .collect();
        let engine = evaluate_new(&rules, &request, body);
        assert_eq!(engine, case.expected, "engine mismatch: {}", case.name);
    }
}

/// A managed (injected) POST request at `path` — the shared input for the
/// default-law tests below (the deny-default carve keys on injected + non-LLM).
fn floor_req(path: &str, injected: bool, llm: bool) -> PolicyRequest {
    PolicyRequest {
        host: "api.example.com".to_string(),
        path: path.to_string(),
        method: "POST".to_string(),
        agent_id: "agent-1".to_string(),
        user_ids: Vec::new(),
        group_ids: Vec::new(),
        has_injections: injected,
        is_llm_host: llm,
        winning_connection_id: None,
    }
}

/// Step 6 (identity matching, engine-only — the old oracle can't express a
/// directory-identity rule, so this is validated in isolation in both ports). A
/// rule targeting a group/user matches iff that principal is in the
/// request's resolved set. Exercises the real path: decode (`assemble_v2`) →
/// match (`identity_matches`) → decide (`evaluate_new`).
#[test]
fn directory_identity_rule_matches_via_principal_set() {
    use sqlx::types::Json;

    // A published v2 row (org scope) with the given identities + a wildcard
    // network target. `is_default` builds a permissive org Default Rule (allow).
    let v2_row = |identities: serde_json::Value, is_default: bool| db::PolicyRuleV2Row {
        id: "r".to_string(),
        logical_id: "lr".to_string(),
        name: "rule".to_string(),
        source: "custom".to_string(),
        priority: if is_default { 100 } else { 1 },
        is_default,
        action: if is_default {
            "allow".to_string()
        } else {
            "block".to_string()
        },
        rate_limit: None,
        rate_limit_window: None,
        require_approval: false,
        conditions: None,
        identities: Json(serde_json::from_value(identities).unwrap()),
        targets: Json(
            serde_json::from_value(serde_json::json!([
                { "kind": "network", "hostPattern": "*", "pathPattern": "*", "method": null }
            ]))
            .unwrap(),
        ),
    };
    // A block rule for group g1, plus a permissive org Default (so a non-matching
    // request falls through to allow).
    let org = vec![
        v2_row(
            serde_json::json!([
                { "agentId": null, "userId": null, "groupId": "g1" }
            ]),
            false,
        ),
        v2_row(serde_json::json!([]), true),
    ];
    let rules = super::assemble::assemble_v2(
        &org,
        &[],
        &db::SecretHosts::default(),
        &db::ConnectionProviders::default(),
    );

    let req = |group_ids: Vec<String>| PolicyRequest {
        host: "api.example.com".to_string(),
        path: "/x".to_string(),
        method: "GET".to_string(),
        agent_id: "a1".to_string(),
        user_ids: Vec::new(),
        group_ids,
        has_injections: false,
        is_llm_host: false,
        winning_connection_id: None,
    };

    // Agent inherits group g1 → the g1 block rule matches.
    assert_eq!(
        evaluate_new(&rules, &req(vec!["g1".to_string()]), ConditionBody::None),
        Decision::block(),
        "a group-g1 rule blocks an agent whose principal set includes g1"
    );
    // Agent inherits a different group → the g1 rule is skipped → org Default allow.
    assert_eq!(
        evaluate_new(&rules, &req(vec!["other".to_string()]), ConditionBody::None),
        Decision::allow(),
        "the group rule does not match an agent lacking g1"
    );
    // Empty principal set (pure-agent traffic) → no directory match → allow.
    assert_eq!(
        evaluate_new(&rules, &req(Vec::new()), ConditionBody::None),
        Decision::allow(),
        "an empty principal set never matches a directory-identity rule"
    );
}

/// Layer 1 (orphan-to-any fail-closed): a NON-DEFAULT rule with ZERO targets
/// matches NOTHING — never "any". A rule left target-less (e.g. its sole
/// connection/secret target was deleted → FK cascade) goes inert instead of
/// silently matching every request; the decision falls through to the org
/// Default. Empty IDENTITIES ("any agent") stay unchanged — this isolates the
/// TARGET axis. Contrast the positive control: the same rule WITH a matching
/// wildcard target still fires.
#[test]
fn empty_target_non_default_rule_matches_nothing() {
    use sqlx::types::Json;

    // A published v2 row with the given targets; empty identities = any agent.
    let row = |targets: serde_json::Value, is_default: bool, action: &str| db::PolicyRuleV2Row {
        id: "r".to_string(),
        logical_id: "lr".to_string(),
        name: "rule".to_string(),
        source: "custom".to_string(),
        priority: if is_default { 100 } else { 1 },
        is_default,
        action: action.to_string(),
        rate_limit: None,
        rate_limit_window: None,
        require_approval: false,
        conditions: None,
        identities: Json(serde_json::from_value(serde_json::json!([])).unwrap()),
        targets: Json(serde_json::from_value(targets).unwrap()),
    };

    let request = PolicyRequest {
        host: "api.example.com".to_string(),
        path: "/anything".to_string(),
        method: "GET".to_string(),
        agent_id: "a1".to_string(),
        user_ids: Vec::new(),
        group_ids: Vec::new(),
        has_injections: false,
        is_llm_host: false,
        winning_connection_id: None,
    };

    // A non-default BLOCK rule with ZERO targets, plus a permissive org Default.
    let orphaned = super::assemble::assemble_v2(
        &[
            row(serde_json::json!([]), false, "block"),
            row(serde_json::json!([]), true, "allow"),
        ],
        &[],
        &db::SecretHosts::default(),
        &db::ConnectionProviders::default(),
    );
    assert_eq!(
        evaluate_new(&orphaned, &request, ConditionBody::None),
        Decision::allow(),
        "a non-default rule with zero targets must match nothing (fail-closed), \
         not silently block every request"
    );

    // Positive control: the SAME block rule WITH a matching wildcard target DOES
    // block — proving it is the empty target list (not the identity/default) that
    // makes the rule inert.
    let with_target = super::assemble::assemble_v2(
        &[
            row(
                serde_json::json!([
                    { "kind": "network", "hostPattern": "*", "pathPattern": "*", "method": null }
                ]),
                false,
                "block",
            ),
            row(serde_json::json!([]), true, "allow"),
        ],
        &[],
        &db::SecretHosts::default(),
        &db::ConnectionProviders::default(),
    );
    assert_eq!(
        evaluate_new(&with_target, &request, ConditionBody::None),
        Decision::block(),
        "the same rule with a matching wildcard target still blocks (control)"
    );
}

/// Step 8 — a `secret` target PERMITS/denies its host (symmetric with an app
/// target): permit on allow (+ inject at connect), block on block. Verifies the
/// specific-secret + "all of the workspace's custom secrets" permits, the CHANGE-2
/// hard floor (a lone workspace secret can't self-authorize past the org
/// deny-default), strictest-wins (an org block beats it), and fail-closed on a
/// missing/deleted secret.
#[test]
fn secret_target_permits_its_host() {
    use sqlx::types::Json;
    use std::collections::HashMap;

    // A v2 row: action, is_default, EMPTY identities (any agent), the given targets.
    let row = |action: &str, is_default: bool, targets: serde_json::Value| db::PolicyRuleV2Row {
        id: "r".to_string(),
        logical_id: "lr".to_string(),
        name: "rule".to_string(),
        source: "custom".to_string(),
        priority: if is_default { 100 } else { 1 },
        is_default,
        action: action.to_string(),
        rate_limit: None,
        rate_limit_window: None,
        require_approval: false,
        conditions: None,
        identities: Json(serde_json::from_value(serde_json::json!([])).unwrap()),
        targets: Json(serde_json::from_value(targets).unwrap()),
    };
    let secret = |id: &str| serde_json::json!([{ "kind": "secret", "secretId": id }]);
    let all_workspace_secrets =
        || serde_json::json!([{ "kind": "secret", "secretScope": "workspace" }]);
    let deny_default = || row("block", true, serde_json::json!([]));

    // The acting workspace owns a google.com + a stripe.com secret; no org secrets.
    let secret_hosts = db::SecretHosts {
        by_id: HashMap::from([
            ("s-goog".to_string(), vec!["google.com".to_string()]),
            ("s-stripe".to_string(), vec!["stripe.com".to_string()]),
        ]),
        workspace_hosts: vec!["google.com".to_string(), "stripe.com".to_string()],
        org_hosts: Vec::new(),
    };
    // A managed request to google.com (a secret is injected → has_injections).
    let req = |host: &str| PolicyRequest {
        host: host.to_string(),
        path: "/v1".to_string(),
        method: "GET".to_string(),
        agent_id: "a1".to_string(),
        user_ids: Vec::new(),
        group_ids: Vec::new(),
        has_injections: true,
        is_llm_host: false,
        winning_connection_id: None,
    };
    let decide = |org: &[db::PolicyRuleV2Row], workspace: &[db::PolicyRuleV2Row], host: &str| {
        let rules = super::assemble::assemble_v2(
            org,
            workspace,
            &secret_hosts,
            &db::ConnectionProviders::default(),
        );
        evaluate_new(&rules, &req(host), ConditionBody::None)
    };

    // 1) CHANGE-2 HARD FLOOR: a lone WORKSPACE secret allow can't open the org
    //    deny-default — even though the secret now permits at the workspace level.
    assert_eq!(
        decide(
            &[deny_default()],
            &[row("allow", false, secret("s-goog"))],
            "google.com",
        ),
        Decision::block_by_default(),
        "a workspace secret rule cannot self-authorize past the org deny-default"
    );

    // 2) An ORG "allow all of the workspace's custom secrets" (secret scope=workspace)
    //    PERMITS the request — google.com is one of the workspace's secret hosts.
    assert_eq!(
        decide(
            &[row("allow", false, all_workspace_secrets()), deny_default()],
            &[],
            "google.com",
        ),
        Decision::allow(),
        "an org 'all workspace secrets' allow permits a workspace secret's host"
    );

    // 3) A specific ORG secret allow permits exactly its own host.
    assert_eq!(
        decide(
            &[row("allow", false, secret("s-goog")), deny_default()],
            &[],
            "google.com",
        ),
        Decision::allow(),
        "a specific org secret allow permits its host"
    );

    // 4) STRICTEST-WINS: an org BLOCK on the secret's host beats a workspace secret
    //    allow (block via a secret target is symmetric with block via app/network).
    assert_eq!(
        decide(
            &[row("block", false, secret("s-goog"))],
            &[row("allow", false, secret("s-goog"))],
            "google.com",
        ),
        Decision::block(),
        "an org block on the secret's host beats a workspace secret allow"
    );

    // 5) FAIL-CLOSED: a secret target naming a missing/deleted secret resolves to
    //    no host → never matches → the org deny-default still blocks.
    assert_eq!(
        decide(
            &[deny_default()],
            &[row("allow", false, secret("s-deleted"))],
            "google.com",
        ),
        Decision::block_by_default(),
        "a secret target with an unresolvable id matches nothing (fail-closed)"
    );

    // 6) BOUNDED: 'all workspace secrets' permits ONLY the workspace's secret hosts —
    //    a different host is not permitted, so the deny-default still blocks it.
    assert_eq!(
        decide(
            &[row("allow", false, all_workspace_secrets()), deny_default()],
            &[],
            "evil.example.com",
        ),
        Decision::block_by_default(),
        "'all workspace secrets' permits only the workspace's secret hosts, not others"
    );
}

/// The step-8 symmetry closed for the APP shapes: an `app` target with NO tools
/// (the dialog's "All connections at a level" — and the bare provider-only API
/// shape) and a resolved `connection` target PERMIT/deny their provider's
/// catalog hosts — host-only, any path/method — exactly like a `secret` target.
/// Verifies the user-reported shape (a workspace "Allow gmail · all connections"
/// permits gmail's host past the workspace deny-default), the block direction (an
/// org whole-app block is real), the CHANGE-2 hard floor, `connectionScope`'s
/// irrelevance to matching, resolved vs missing connection targets, and
/// fail-closed on unknown providers + hosts outside the provider's catalog set.
#[test]
fn app_scope_and_connection_targets_permit_their_provider_hosts() {
    use sqlx::types::Json;
    use std::collections::HashMap;

    // A v2 row: action, is_default, EMPTY identities (any agent), the given targets.
    let row = |action: &str, is_default: bool, targets: serde_json::Value| db::PolicyRuleV2Row {
        id: "r".to_string(),
        logical_id: "lr".to_string(),
        name: "rule".to_string(),
        source: "custom".to_string(),
        priority: if is_default { 100 } else { 1 },
        is_default,
        action: action.to_string(),
        rate_limit: None,
        rate_limit_window: None,
        require_approval: false,
        conditions: None,
        identities: Json(serde_json::from_value(serde_json::json!([])).unwrap()),
        targets: Json(serde_json::from_value(targets).unwrap()),
    };
    // "All connections at a level": an app target with a connectionScope and NO
    // tools — the dialog's `mode: "all"` build. `scope: None` = the bare shape.
    let app_all = |provider: &str, scope: Option<&str>| serde_json::json!([{ "kind": "app", "appProvider": provider, "appConnectionScope": scope }]);
    let connection =
        |id: &str| serde_json::json!([{ "kind": "connection", "appConnectionId": id }]);
    // A connection target NARROWED to specific tools (the tools-picker shape in
    // "Specific connection(s)" mode): matches only those tools' endpoints.
    let connection_tools = |id: &str, tools: &[&str]| serde_json::json!([{ "kind": "connection", "appConnectionId": id, "appTools": tools }]);
    let allow_default = || row("allow", true, serde_json::json!([]));
    let deny_default = || row("block", true, serde_json::json!([]));

    // The fenced connect-time map: the workspace owns TWO gmail connections (the
    // per-account differential needs same-provider siblings) + a github one.
    let providers = db::ConnectionProviders {
        by_id: HashMap::from([
            ("c-gmail".to_string(), "gmail".to_string()),
            ("c-gmail2".to_string(), "gmail".to_string()),
            ("c-github".to_string(), "github".to_string()),
        ]),
    };
    // A managed request (a credential is injected → the defaults enforce). The
    // winner defaults to the gmail connection so pre-existing connection-target
    // arms keep exercising the MATCHING direction; the non-matching direction
    // has its own arms below.
    let req = |host: &str| PolicyRequest {
        host: host.to_string(),
        path: "/gmail/v1/users/me/messages".to_string(),
        method: "GET".to_string(),
        agent_id: "a1".to_string(),
        user_ids: Vec::new(),
        group_ids: Vec::new(),
        has_injections: true,
        is_llm_host: false,
        winning_connection_id: Some("c-gmail".to_string()),
    };
    // A request with an explicit method + path AND winner — for the per-tool
    // endpoint tests and the per-account differentials.
    let req_full = |host: &str, method: &str, path: &str, winner: Option<&str>| PolicyRequest {
        host: host.to_string(),
        path: path.to_string(),
        method: method.to_string(),
        agent_id: "a1".to_string(),
        user_ids: Vec::new(),
        group_ids: Vec::new(),
        has_injections: true,
        is_llm_host: false,
        winning_connection_id: winner.map(str::to_string),
    };
    let decide_req = |org: &[db::PolicyRuleV2Row],
                      workspace: &[db::PolicyRuleV2Row],
                      request: &PolicyRequest| {
        let rules =
            super::assemble::assemble_v2(org, workspace, &db::SecretHosts::default(), &providers);
        evaluate_new(&rules, request, ConditionBody::None)
    };
    let decide = |org: &[db::PolicyRuleV2Row], workspace: &[db::PolicyRuleV2Row], host: &str| {
        let rules =
            super::assemble::assemble_v2(org, workspace, &db::SecretHosts::default(), &providers);
        evaluate_new(&rules, &req(host), ConditionBody::None)
    };

    // 1) THE USER'S REPRO: a workspace "Allow gmail · all connections (workspace)"
    //    permits gmail's catalog host past the workspace deny-default (allowlist
    //    mode) — the rule now includes the app's traffic, not just injection.
    assert_eq!(
        decide(
            &[allow_default()],
            &[
                row("allow", false, app_all("gmail", Some("workspace"))),
                deny_default(),
            ],
            "gmail.googleapis.com",
        ),
        Decision::allow(),
        "a workspace 'allow gmail · all connections' permits gmail's host in allowlist mode"
    );

    // 2) BOUNDED: the same rules leave a host OUTSIDE gmail's catalog set to the
    //    workspace deny-default — the permit surface is exactly the provider's hosts.
    assert_eq!(
        decide(
            &[allow_default()],
            &[
                row("allow", false, app_all("gmail", Some("workspace"))),
                deny_default(),
            ],
            "api.github.com",
        ),
        Decision::block_by_default(),
        "a whole-app allow permits only its provider's catalog hosts"
    );

    // 3) BLOCK DIRECTION: an org "Block <app> · all connections" is a REAL
    //    whole-app block — any path/method on the provider's hosts —
    //    unconditionally (a block must never be silenced by connection state).
    assert_eq!(
        decide(
            &[
                row("block", false, app_all("github", Some("organization"))),
                allow_default(),
            ],
            &[],
            "api.github.com",
        ),
        Decision::block(),
        "an org whole-app block blocks the provider's hosts"
    );

    // 4) CHANGE-2 HARD FLOOR: a lone WORKSPACE whole-app allow can't open the org
    //    deny-default (same floor the secret symmetry respects).
    assert_eq!(
        decide(
            &[deny_default()],
            &[row("allow", false, app_all("gmail", Some("workspace")))],
            "gmail.googleapis.com",
        ),
        Decision::block_by_default(),
        "a workspace whole-app allow cannot self-authorize past the org deny-default"
    );

    // 5) `connectionScope` is INJECTION-ONLY — the bare provider shape (no scope)
    //    matches identically (the level picks the injection pool, never the hosts).
    assert_eq!(
        decide(
            &[allow_default()],
            &[row("allow", false, app_all("gmail", None)), deny_default()],
            "gmail.googleapis.com",
        ),
        Decision::allow(),
        "connectionScope does not affect matching (bare app shape matches too)"
    );

    // 6) A resolved `connection` target permits its provider's hosts (the fenced
    //    map resolved c-gmail → gmail at connect).
    assert_eq!(
        decide(
            &[allow_default()],
            &[row("allow", false, connection("c-gmail")), deny_default()],
            "gmail.googleapis.com",
        ),
        Decision::allow(),
        "a specific-connection allow permits its provider's hosts"
    );

    // 6b) PER-ACCOUNT: the SAME rules, the SAME host — but the request was
    //     served by the SIBLING gmail account. The allow names c-gmail only, so
    //     it contributes nothing and the deny-default blocks. This is the
    //     "allow work@, not support@" law.
    assert_eq!(
        decide_req(
            &[allow_default()],
            &[row("allow", false, connection("c-gmail")), deny_default()],
            &req_full(
                "gmail.googleapis.com",
                "GET",
                "/gmail/v1/users/me/messages",
                Some("c-gmail2"),
            ),
        ),
        Decision::block_by_default(),
        "a specific-connection allow does not open a same-provider sibling account"
    );

    // 6c) NO WINNER: no app connection served this request (secret-served or
    //     uncredentialed-but-injected traffic) — a connection target never
    //     matches (fail-closed for allow AND block).
    assert_eq!(
        decide_req(
            &[allow_default()],
            &[row("allow", false, connection("c-gmail")), deny_default()],
            &req_full(
                "gmail.googleapis.com",
                "GET",
                "/gmail/v1/users/me/messages",
                None,
            ),
        ),
        Decision::block_by_default(),
        "no winning connection → a connection allow contributes nothing"
    );

    // 7) FAIL-CLOSED: a connection id absent from the fenced map (deleted in the
    //    cache window, or foreign/forged) matches nothing.
    assert_eq!(
        decide(
            &[allow_default()],
            &[row("allow", false, connection("c-gone")), deny_default()],
            "gmail.googleapis.com",
        ),
        Decision::block_by_default(),
        "an unresolvable connection target matches nothing (fail-closed)"
    );

    // 8) FAIL-CLOSED: an unknown/catalog-less provider resolves to no hosts — the
    //    permit surface can never exceed the shared catalog.
    assert_eq!(
        decide(
            &[allow_default()],
            &[
                row(
                    "allow",
                    false,
                    app_all("no_such_provider", Some("workspace"))
                ),
                deny_default(),
            ],
            "gmail.googleapis.com",
        ),
        Decision::block_by_default(),
        "a catalog-less provider permits nothing"
    );

    // 9) TOOL-NARROWED CONNECTION: a connection target carrying tools matches ONLY
    //    those tools' endpoints of its provider (create_issue = POST
    //    api.github.com /repos/*/*/issues). The narrowed endpoint permits…
    assert_eq!(
        decide_req(
            &[allow_default()],
            &[
                row(
                    "allow",
                    false,
                    connection_tools("c-github", &["create_issue"])
                ),
                deny_default(),
            ],
            &req_full(
                "api.github.com",
                "POST",
                "/repos/o/r/issues",
                Some("c-github"),
            ),
        ),
        Decision::allow(),
        "a tool-narrowed connection permits its named tool's endpoint"
    );

    // 10) …and a DIFFERENT endpoint of the SAME provider (wrong method/path) is not
    //     matched — the narrowing is exact, so the deny-default still blocks it.
    assert_eq!(
        decide_req(
            &[allow_default()],
            &[
                row(
                    "allow",
                    false,
                    connection_tools("c-github", &["create_issue"])
                ),
                deny_default(),
            ],
            &req_full(
                "api.github.com",
                "GET",
                "/repos/o/r/issues",
                Some("c-github"),
            ),
        ),
        Decision::block_by_default(),
        "a tool-narrowed connection does NOT match the provider's other endpoints"
    );

    // 11) BLOCK DIRECTION, PER-ACCOUNT: a block naming c-gmail binds only when
    //     that account wins injection…
    assert_eq!(
        decide_req(
            &[allow_default()],
            &[row("block", false, connection("c-gmail")), allow_default()],
            &req_full(
                "gmail.googleapis.com",
                "GET",
                "/gmail/v1/users/me/messages",
                Some("c-gmail"),
            ),
        ),
        Decision::block(),
        "a specific-connection block binds when its account wins injection"
    );

    // 12) …and the sibling account sails past it to the permissive default —
    //     the deliberate semantic change from the provider-wide decode (a
    //     whole-app block, arm 3, is still the tool for provider-wide denies).
    assert_eq!(
        decide_req(
            &[allow_default()],
            &[row("block", false, connection("c-gmail")), allow_default()],
            &req_full(
                "gmail.googleapis.com",
                "GET",
                "/gmail/v1/users/me/messages",
                Some("c-gmail2"),
            ),
        ),
        Decision::allow(),
        "a specific-connection block does not bind a same-provider sibling account"
    );
}

/// A minimal published v2 row for the uniform-default-law tests below: a
/// network rule on api.example.com at `path`, or a target-less Default Rule
/// (`path: None` + `is_default: true`). Empty identities = any agent.
fn law_row(action: &str, is_default: bool, path: Option<&str>) -> db::PolicyRuleV2Row {
    use sqlx::types::Json;
    let targets = match path {
        Some(p) => serde_json::json!([
            { "kind": "network", "hostPattern": "api.example.com", "pathPattern": p, "method": null }
        ]),
        None => serde_json::json!([]),
    };
    db::PolicyRuleV2Row {
        id: "r".to_string(),
        logical_id: "lr".to_string(),
        name: "rule".to_string(),
        source: if is_default { "default" } else { "custom" }.to_string(),
        priority: if is_default { 100 } else { 1 },
        is_default,
        action: action.to_string(),
        rate_limit: None,
        rate_limit_window: None,
        require_approval: false,
        conditions: None,
        identities: Json(serde_json::from_value(serde_json::json!([])).unwrap()),
        targets: Json(serde_json::from_value(targets).unwrap()),
    }
}

/// Decide a request against hand-built org/workspace row slices via the real
/// assembly path — these are the first fixtures to place an `is_default` row in
/// the WORKSPACE slice, so they also prove assemble_v2 passes workspace Default
/// Rules through to the engine.
fn law_decide(
    org: &[db::PolicyRuleV2Row],
    workspace: &[db::PolicyRuleV2Row],
    req: &PolicyRequest,
) -> Decision {
    let rules = super::assemble::assemble_v2(
        org,
        workspace,
        &db::SecretHosts::default(),
        &db::ConnectionProviders::default(),
    );
    evaluate_new(&rules, req, ConditionBody::None)
}

/// Step 9 part 1 — the uniform per-level default law: each level's verdict is
/// its first matching rule, else its Default Rule; the stricter verdict wins.
/// A workspace Default Rule Block = ALLOWLIST MODE: an org allow is "permission",
/// not traffic — the workspace mirrors each allow it wants.
#[test]
fn workspace_default_block_denies_unmatched_org_allow() {
    let org = vec![law_row("allow", false, Some("/api"))];
    let workspace = vec![law_row("block", true, None)];
    assert_eq!(
        law_decide(&org, &workspace, &floor_req("/api", true, false)),
        Decision::block_by_default(),
        "allowlist mode: an org allow the workspace didn't mirror is denied by the workspace default"
    );
}

#[test]
fn workspace_default_block_carve_exempts_llm() {
    let org = vec![law_row("allow", false, Some("/api"))];
    let workspace = vec![law_row("block", true, None)];
    assert_eq!(
        law_decide(&org, &workspace, &floor_req("/api", true, true)),
        Decision::allow(),
        "the enforce_deny carve exempts LLM hosts from the workspace default Block"
    );
}

#[test]
fn workspace_default_block_denies_org_approval_rule() {
    let mut approval = law_row("allow", false, Some("/api"));
    approval.require_approval = true;
    let workspace = vec![law_row("block", true, None)];
    assert_eq!(
        law_decide(&[approval], &workspace, &floor_req("/api", true, false)),
        Decision::block_by_default(),
        "approval/rate rules are Action::Allow — they defer to the workspace default \
         Block, symmetric with the org hard floor"
    );
}

#[test]
fn workspace_default_block_keeps_org_block_attribution() {
    let org = vec![law_row("block", false, Some("/api"))];
    let workspace = vec![law_row("block", true, None)];
    assert_eq!(
        law_decide(&org, &workspace, &floor_req("/api", true, false)),
        Decision::block(),
        "an explicit org block keeps RULE attribution (not by-default)"
    );
}

#[test]
fn workspace_default_block_wins_over_org_allow_posture() {
    let org = vec![law_row("allow", true, None)];
    let workspace = vec![law_row("block", true, None)];
    assert_eq!(
        law_decide(&org, &workspace, &floor_req("/api", true, false)),
        Decision::block_by_default(),
        "with no matches, the stricter of the two level defaults wins"
    );
}

#[test]
fn workspace_default_block_under_org_block_posture() {
    let org = vec![law_row("block", true, None)];
    let workspace = vec![law_row("block", true, None)];
    assert_eq!(
        law_decide(&org, &workspace, &floor_req("/api", true, false)),
        Decision::block_by_default(),
        "both floors down still denies by default"
    );
}

#[test]
fn workspace_explicit_match_bypasses_workspace_default() {
    let org = vec![law_row("allow", true, None)];
    let workspace = vec![
        law_row("allow", false, Some("/api")),
        law_row("block", true, None),
    ];
    assert_eq!(
        law_decide(&org, &workspace, &floor_req("/api", true, false)),
        Decision::allow(),
        "a matching workspace rule IS the workspace verdict — the default is not consulted"
    );
}

/// A workspace default ALLOW must be a NO-OP everywhere: present ≡ absent across
/// the representative cells (incl. the CHANGE-2 org-floor cell). This is the
/// mechanical face of "byte-identical while every workspace default is Allow".
#[test]
fn workspace_default_allow_is_neutral() {
    let check = |org: &[db::PolicyRuleV2Row],
                 without: &[db::PolicyRuleV2Row],
                 with: &[db::PolicyRuleV2Row],
                 label: &str| {
        for llm in [false, true] {
            let req = floor_req("/api", true, llm);
            assert_eq!(
                law_decide(org, without, &req),
                law_decide(org, with, &req),
                "a workspace default Allow must be neutral: {label} (llm={llm})"
            );
        }
    };
    check(
        &[law_row("allow", false, Some("/api"))],
        &[],
        &[law_row("allow", true, None)],
        "org allow rule, no workspace rules",
    );
    check(
        &[law_row("block", true, None)],
        &[law_row("allow", false, Some("/api"))],
        &[
            law_row("allow", false, Some("/api")),
            law_row("allow", true, None),
        ],
        "the CHANGE-2 cell (org deny posture + lone workspace allow)",
    );
    check(
        &[law_row("block", false, Some("/api"))],
        &[law_row("allow", false, Some("/api"))],
        &[
            law_row("allow", false, Some("/api")),
            law_row("allow", true, None),
        ],
        "org block rule vs workspace allow rule",
    );
    check(
        &[law_row("allow", true, None)],
        &[],
        &[law_row("allow", true, None)],
        "org allow posture only",
    );
    check(
        &[law_row("block", true, None)],
        &[],
        &[law_row("allow", true, None)],
        "org deny posture only",
    );
}

#[test]
fn workspace_default_not_consulted_when_both_levels_match() {
    // Both levels match: the workspace's verdict is its RULE, so the workspace
    // default Block must not be consulted — and the org rate modifier must
    // survive strictest-combine. Pinned as equality with the default-free set
    // (kills the mutant that drops the org match whenever the workspace default
    // blocks), plus a non-bare-allow check proving the modifier survived.
    let mut org_rate = law_row("allow", false, Some("/api"));
    org_rate.rate_limit = Some(5);
    org_rate.rate_limit_window = Some("minute".to_string());
    let org = vec![org_rate];
    let req = floor_req("/api", true, false);
    let with_default = law_decide(
        &org,
        &[
            law_row("allow", false, Some("/api")),
            law_row("block", true, None),
        ],
        &req,
    );
    let without = law_decide(&org, &[law_row("allow", false, Some("/api"))], &req);
    assert_eq!(
        with_default, without,
        "a matched level never consults its default — both-match cells are \
         untouched by the workspace default Block"
    );
    assert_ne!(
        with_default,
        Decision::allow(),
        "the org rate modifier survives the combine (not a bare allow)"
    );
}

#[test]
fn workspace_default_block_without_any_org_side() {
    // No org rows at all: the workspace default Block still denies the unmatched
    // request. (Live, an org with zero published org rows never reaches v2 —
    // the enforce.rs org-empty legacy gate — but the engine law must hold.)
    assert_eq!(
        law_decide(
            &[],
            &[law_row("block", true, None)],
            &floor_req("/api", true, false),
        ),
        Decision::block_by_default(),
        "the workspace default Block needs no org side to deny"
    );
}

/// Step 9 visibility — the engine's ATTRIBUTION contract for telemetry: the
/// outcome names the winning rule, and a deny-default names the blocking
/// Default Rule (org-first when both levels block). The Decision-level law
/// stays covered by the tests above; these pin only what telemetry reads.
#[test]
fn outcome_attributes_the_winning_rule() {
    let org = vec![law_row("block", false, Some("/api"))];
    let rules = super::assemble::assemble_v2(
        &org,
        &[],
        &db::SecretHosts::default(),
        &db::ConnectionProviders::default(),
    );
    match evaluate_outcome(&rules, &floor_req("/api", true, false), ConditionBody::None) {
        Outcome::Rule(rule) => {
            assert_eq!(rule.logical_id, "lr");
            assert_eq!(rule.name, "rule");
        }
        _ => panic!("expected the explicit block rule to win with attribution"),
    }
}

#[test]
fn deny_default_attributes_the_org_default_first() {
    let org = vec![law_row("block", true, None)];
    let workspace = vec![law_row("block", true, None)];
    let rules = super::assemble::assemble_v2(
        &org,
        &workspace,
        &db::SecretHosts::default(),
        &db::ConnectionProviders::default(),
    );
    match evaluate_outcome(&rules, &floor_req("/api", true, false), ConditionBody::None) {
        Outcome::DenyDefault(Some(default_rule)) => {
            assert!(default_rule.is_default);
            assert_eq!(
                default_rule.scope,
                Scope::Organization,
                "org-first attribution"
            );
        }
        _ => panic!("expected an attributed deny-default"),
    }
}

#[test]
fn lone_workspace_default_block_attributes_the_workspace() {
    let workspace = vec![law_row("block", true, None)];
    let rules = super::assemble::assemble_v2(
        &[],
        &workspace,
        &db::SecretHosts::default(),
        &db::ConnectionProviders::default(),
    );
    match evaluate_outcome(&rules, &floor_req("/api", true, false), ConditionBody::None) {
        Outcome::DenyDefault(Some(default_rule)) => {
            assert_eq!(default_rule.scope, Scope::Workspace);
        }
        _ => panic!("expected the workspace default to be attributed"),
    }
}
