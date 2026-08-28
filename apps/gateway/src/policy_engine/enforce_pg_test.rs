//! EE enforce sanity suite over a REAL Postgres, driving the production loaders
//! (`find_secret_hosts` et al.) → real `assemble_v2` → real `evaluate_new` against
//! fixtures seeded by `packages/api/src/ee/testing/gateway-enforce-seed.ts`.
//!
//! This is the permanent, CI-run guard for the credential-injection host-bypass class:
//! a rule's enforcement must cover EVERY host the credential injects on (the reported
//! Gmail `www.googleapis.com` leak, the OpenAI multi-host secret, EE regional mirrors),
//! and must not over-grab unrelated traffic on a shared host.
//!
//! Gated on `GATEWAY_TEST_DATABASE_URL` like the other gateway DB tests
//! (`auth.rs`): skipped locally when unset, but MUST run in CI (fails loudly
//! otherwise). The CI `rust` job seeds the fixtures right after `prisma migrate
//! deploy`; run locally with:
//!   pnpm --filter @onecli/api-server exec tsx \
//!     ../../packages/api/src/ee/testing/gateway-enforce-seed.ts   # DATABASE_URL set
//!   GATEWAY_TEST_DATABASE_URL=… cargo test -p onecli-gateway enforce_pg
use super::assemble::assemble_v2;
use super::evaluate::evaluate_new;
use super::loaders::find_published_policy_rules_v2_by_org;
use super::types::{Decision, PolicyRequest};
use crate::db::{
    create_pool, find_connection_providers, find_published_policy_rules_v2_by_workspace,
    find_secret_hosts,
};
use sqlx::PgPool;

// Fixture ids — must match `FIXTURE` in gateway-enforce-seed.ts.
const ORG: &str = "gwenf-org";
const WORKSPACE: &str = "gwenf-ws";
const WORKSPACE_FENCE: &str = "gwenf-ws-b";
const SECRET_OPENAI: &str = "gwenf-sec-openai";
const SECRET_OPENAI_KEY: &str = "gwenf-sec-openai-key";
/// The connection `rule-github-conn` names, and its same-provider sibling —
/// the pair that makes the per-connection differential falsifiable.
const CONN_GITHUB: &str = "gwenf-conn-github";
const CONN_GITHUB2: &str = "gwenf-conn-github2";
/// The calendar connection whose grant stack the seed authors via the REAL
/// grants compiler (allow list_events, ask create_event) — these assertions
/// prove the gateway enforces genuine service output.
const CONN_GCAL: &str = "gwenf-conn-gcal";
/// Row id of the seed's DISABLED block rule (`${P}rule-disabled`).
const RULE_DISABLED: &str = "gwenf-rule-disabled";

async fn test_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
        // Local-only escape hatch. In CI these tests MUST run — a silent skip would
        // let this bypass class regress — so fail loudly if the URL wasn't wired up.
        assert!(
            std::env::var("CI").is_err(),
            "GATEWAY_TEST_DATABASE_URL must be set in CI: the gateway enforce tests must not silently skip"
        );
        eprintln!("skipping: GATEWAY_TEST_DATABASE_URL unset");
        return None;
    };
    Some(create_pool(&url).await.expect("connect to test database"))
}

/// A managed (credential-injected) non-LLM request — the reported scenario.
/// `winner` is the app connection that won injection (None = secret-served).
fn req_via(host: &str, method: &str, path: &str, winner: Option<&str>) -> PolicyRequest {
    PolicyRequest {
        host: host.to_string(),
        path: path.to_string(),
        method: method.to_string(),
        agent_id: "gwenf-agent".to_string(),
        user_ids: Vec::new(),
        group_ids: Vec::new(),
        has_injections: true,
        is_llm_host: false,
        winning_connection_id: winner.map(str::to_string),
    }
}

fn req(host: &str, method: &str, path: &str) -> PolicyRequest {
    // Default winner: the first seeded GitHub connection — the pre-existing
    // connection-target assertion exercises the matching direction; the
    // differential cases below use `req_via` explicitly.
    req_via(host, method, path, Some(CONN_GITHUB))
}

#[tokio::test]
async fn enforce_over_seeded_fixtures_closes_the_injection_host_bypass() {
    let Some(pool) = test_pool().await else {
        return;
    };

    // Drive the real connect-time LOADERS (incl. the Fix-C `find_secret_hosts`) →
    // real `assemble_v2` → real `evaluate_new`: the decision engine over
    // Postgres-loaded rows. These fixtures are workspace-scope with a workspace default;
    // the higher-level `evaluate` seam additionally gates on an org rule existing, so
    // this suite deliberately tests at the loader+engine level (where the fix lives).
    let org = find_published_policy_rules_v2_by_org(&pool, ORG)
        .await
        .expect("load org rules");
    let workspace = find_published_policy_rules_v2_by_workspace(&pool, WORKSPACE)
        .await
        .expect("load workspace rules");

    // Fixtures-present guard: an empty workspace means the seed step didn't run. In CI
    // that's a wiring failure (the seed must precede the tests); locally, a notice.
    if workspace.is_empty() {
        assert!(
            std::env::var("CI").is_err(),
            "gwenf fixtures missing in CI: the 'Seed gateway enforce fixtures' step must run before the gateway tests"
        );
        eprintln!("skipping: gwenf fixtures not seeded (run gateway-enforce-seed.ts first)");
        return;
    }

    let secret_hosts = find_secret_hosts(&pool, ORG, WORKSPACE)
        .await
        .expect("load secret hosts");
    let providers = find_connection_providers(&pool, ORG, WORKSPACE)
        .await
        .expect("load connection providers");
    let rules = assemble_v2(&org, &workspace, &secret_hosts, &providers);
    let decide = |r: &PolicyRequest| evaluate_new(&rules, r, None);

    // Fix C — the real find_secret_hosts SQL must resolve EVERY host the
    // OAuth-mode OpenAI credential injects on, so a block on the secret can't
    // be dodged via a sibling host.
    let openai = secret_hosts
        .by_id
        .get(SECRET_OPENAI)
        .cloned()
        .unwrap_or_default();
    for host in [
        "api.openai.com",
        "chatgpt.com",
        "*.chatgpt.com",
        "*.openai.com",
    ] {
        assert!(
            openai.iter().any(|h| h == host),
            "Fix C: find_secret_hosts must resolve openai host {host}, got {openai:?}"
        );
    }

    // #490 differential — the expansion is gated on `metadata.authMode ==
    // "oauth"`: the API-key-mode sibling (same type, same stored host) must
    // resolve to EXACTLY its stored host. An API key is not a ChatGPT
    // credential, and expanding it injected it into auth.openai.com OAuth
    // exchanges (401 invalid_client) and onto hosts outside its configured
    // pattern. Asserted through the real SQL loader so a dropped `metadata`
    // column in `find_secret_hosts` fails here, not in production.
    let openai_key = secret_hosts
        .by_id
        .get(SECRET_OPENAI_KEY)
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        openai_key,
        vec!["api.openai.com".to_string()],
        "#490: an api-key-mode openai secret must not expand beyond its stored host"
    );

    // (host, method, path, expected, what-it-proves)
    let cases: &[(&str, &str, &str, Decision, &str)] = &[
        (
            "gmail.googleapis.com",
            "POST",
            "/gmail/v1/users/me/drafts",
            Decision::block(),
            "baseline: the canonical Gmail host is blocked",
        ),
        (
            "www.googleapis.com",
            "POST",
            "/gmail/v1/users/me/drafts",
            Decision::block(),
            "THE REPORTED BYPASS: the legacy www Gmail host is now enforced",
        ),
        (
            "www.googleapis.com",
            "POST",
            "/calendar/v3/calendars",
            Decision::allow(),
            "precision: a non-Gmail path on the shared host is NOT over-grabbed",
        ),
        (
            "api.openai.com",
            "POST",
            "/v1/chat/completions",
            Decision::block(),
            "OpenAI secret block on the stored host",
        ),
        (
            "chatgpt.com",
            "POST",
            "/backend-api/conversation",
            Decision::block(),
            "Fix C: the OpenAI secret block covers the other injected host too",
        ),
        (
            "api.datadoghq.com",
            "POST",
            "/api/v1/events",
            Decision::block(),
            "datadog (EE) whole-app block on its primary host",
        ),
        (
            "api.datadoghq.eu",
            "POST",
            "/api/v1/events",
            Decision::block(),
            "datadog (EE) whole-app block covers the EU regional host",
        ),
        (
            "api.github.com",
            "POST",
            "/repos/o/r/issues",
            Decision::block(),
            "connection-target block resolves to the provider's hosts",
        ),
        (
            "blocked.example.com",
            "GET",
            "/",
            Decision::block(),
            "network-target block on a raw host",
        ),
        (
            "example.com",
            "GET",
            "/",
            Decision::allow(),
            "an unrelated host rides the allow-default",
        ),
        (
            "disabled.example.com",
            "GET",
            "/",
            Decision::allow(),
            "a DISABLED block rule does not decide — the `enabled` predicate lives \
             only in the loaders' SQL, so nothing else would catch its removal, and \
             removing it would start enforcing every rule a user switched off",
        ),
    ];
    // The `disabled.example.com` case above allows — but so would any host no rule
    // mentions, so on its own it cannot tell "the disabled rule was skipped" from
    // "there is no such rule". Pin the difference directly: the row EXISTS in the
    // database and the loader still did not return it.
    let disabled_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM policy_rules_v2 WHERE id = $1 AND enabled = false",
    )
    .bind(RULE_DISABLED)
    .fetch_one(&pool)
    .await
    .expect("count the disabled fixture row");
    assert_eq!(
        disabled_rows, 1,
        "fixture missing: the disabled-rule row must exist for its skip to mean anything"
    );
    assert!(
        !workspace.iter().any(|r| r.id == RULE_DISABLED),
        "the loader returned a DISABLED rule — the `enabled` predicate was dropped from its SQL"
    );

    for (host, method, path, expected, why) in cases {
        assert_eq!(
            &decide(&req(host, method, path)),
            expected,
            "{host} {path}: {why}"
        );
    }

    // Per-connection differential: `rule-github-conn` names ONLY the first
    // GitHub connection and the fixture seeds a same-provider sibling, so the
    // block must bind exactly to the winning connection. (With one connection,
    // per-provider and per-connection semantics are indistinguishable — the
    // sibling is what makes these assertions falsifiable.)
    assert!(
        providers.by_id.contains_key(CONN_GITHUB2),
        "fixture missing: the sibling github connection must be in the fenced map"
    );
    assert_eq!(
        decide(&req_via(
            "api.github.com",
            "POST",
            "/repos/o/r/issues",
            Some(CONN_GITHUB),
        )),
        Decision::block(),
        "the connection-target block binds when its own connection wins injection"
    );
    assert_eq!(
        decide(&req_via(
            "api.github.com",
            "POST",
            "/repos/o/r/issues",
            Some(CONN_GITHUB2),
        )),
        Decision::allow(),
        "a same-provider sibling connection sails past the per-connection block"
    );
    assert_eq!(
        decide(&req_via(
            "api.github.com",
            "POST",
            "/repos/o/r/issues",
            None
        )),
        Decision::allow(),
        "no winning connection → the connection-target block does not bind"
    );

    // The COMPILER-AUTHORED grant stack (seeded through the real grants
    // service): allow list_events, ask create_event, delete_event in the
    // blocked complement — all bound to the calendar connection's winner.
    assert_eq!(
        decide(&req_via(
            "www.googleapis.com",
            "GET",
            "/calendar/v3/calendars/c1/events",
            Some(CONN_GCAL),
        )),
        Decision::allow(),
        "grant stack: the allowed tool's endpoint permits via its winner"
    );
    assert_eq!(
        decide(&req_via(
            "www.googleapis.com",
            "POST",
            "/calendar/v3/calendars/c1/events",
            Some(CONN_GCAL),
        )),
        Decision::allow_approval(),
        "grant stack: the ask tool's endpoint requires approval"
    );
    assert_eq!(
        decide(&req_via(
            "www.googleapis.com",
            "DELETE",
            "/calendar/v3/calendars/c1/events/e1",
            Some(CONN_GCAL),
        )),
        Decision::block(),
        "grant stack: an un-chosen tool dies on the explicit blocked complement"
    );
    assert_eq!(
        decide(&req_via(
            "www.googleapis.com",
            "GET",
            "/calendar/v3/calendars/c1/events",
            None,
        )),
        Decision::allow(),
        "grant stack: without its winner the stack does not bind (default rides)"
    );

    // Cross-workspace fence: the second workspace is POPULATED with its OWN distinct rule
    // (a block on a host ws-A never mentions), so isolation is proven in BOTH
    // directions and the test can't pass against an absent workspace. The org rules are
    // org-scoped (shared) — reuse `org`; only the workspace rules differ.
    let workspace_b = find_published_policy_rules_v2_by_workspace(&pool, WORKSPACE_FENCE)
        .await
        .expect("load fence workspace rules");
    assert!(
        !workspace_b.is_empty(),
        "the fence workspace must be seeded with its own rule (rule-fence-b) for this test to mean anything"
    );
    let secrets_b = find_secret_hosts(&pool, ORG, WORKSPACE_FENCE)
        .await
        .expect("load fence secret hosts");
    let providers_b = find_connection_providers(&pool, ORG, WORKSPACE_FENCE)
        .await
        .expect("load fence connection providers");
    let rules_b = assemble_v2(&org, &workspace_b, &secrets_b, &providers_b);

    // ws-A's Gmail block does NOT reach the fence workspace...
    assert_eq!(
        evaluate_new(
            &rules_b,
            &req("www.googleapis.com", "POST", "/gmail/v1/users/me/drafts"),
            None
        ),
        Decision::allow(),
        "fence: ws-A's Gmail block must not apply in the fence workspace"
    );
    // ...the fence workspace's OWN rule DOES apply there (so it's genuinely populated)...
    assert_eq!(
        evaluate_new(&rules_b, &req("fence-only.example.com", "GET", "/"), None),
        Decision::block(),
        "fence: the fence workspace's own rule must apply to it"
    );
    // ...ws-A's OpenAI secret is workspace-fenced out of the fence workspace's set...
    assert!(
        secrets_b.by_id.is_empty(),
        "fence: ws-A's secret leaked into the fence workspace"
    );
    // ...and the reverse holds: the fence workspace's rule does NOT reach ws-A.
    assert_eq!(
        decide(&req("fence-only.example.com", "GET", "/")),
        Decision::allow(),
        "fence: the fence workspace's rule must not apply in ws-A"
    );
}
