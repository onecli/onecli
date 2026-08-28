/**
 * Seeds the fixtures the gateway's in-crate EE enforce tests read
 * (`apps/gateway/src/ee/policy_engine/enforce_pg_test.rs`).
 *
 * Type-safe on purpose: every row — including the nested policy targets, whose
 * array is typed straight from Prisma — goes through the generated `@onecli/db`
 * client, so a renamed/removed/retyped schema COLUMN breaks `pnpm --filter
 * @onecli/api check-types`. What compile-checking does NOT cover: enum-like string
 * VALUES. `action`/`status`/`source` are plain `String` in Prisma with no CHECK, so
 * a bad value there is caught not by the compiler but by the consuming Rust enforce
 * test (e.g. a wrong `status` yields zero published rows → the test fails loudly in
 * CI). Only `scope` and `kind` are additionally CHECK-guarded at insert
 * (`policy_rules_v2_scope_shape`, `policy_rule_targets_kind_shape`).
 *
 * Idempotent and isolated: every fixture id carries the `gwenf-` prefix, and we
 * delete-then-create in FK order. Other gateway DB tests own their own prefixes and
 * only scoped-delete their own rows (no global wipe), so fixtures never collide.
 *
 * Run (DATABASE_URL must point at the target Postgres; the client reads it at import):
 *   pnpm --filter @onecli/api-server exec tsx \
 *     ../../packages/api/src/ee/testing/gateway-enforce-seed.ts
 */
import { db, Prisma } from "@onecli/db";
import { pathToFileURL } from "node:url";
import { setConnectionGrant } from "../../services/grants-service";
import { initPolicyValidator, initRuleActionGate } from "../../providers";

// This is a standalone script — nothing runs `ensureEditionDefaults()`, and CI
// executes it with the cloud edition env, where an uninjected provider read
// fails loudly. Fixture authoring is not an entitlement subject: inject the
// permissive seams explicitly (the same implicit defaults the seed ran with
// before the provider slots became fail-loud).
initRuleActionGate({ assertAllowed: async () => {} });
initPolicyValidator({ validate: async () => {} });

/** Shared fixture id prefix — the Rust test resolves rows by these exact ids. */
const P = "gwenf-";
export const FIXTURE = {
  org: `${P}org`,
  workspace: `${P}ws`,
  workspaceFence: `${P}ws-b`,
  agent: `${P}agent`,
  secretOpenai: `${P}sec-openai`,
  // An API-KEY-mode OpenAI secret: the host expansion is OAuth-only (#490), so
  // this one must resolve to exactly its stored host — the differential that
  // makes the metadata gating falsifiable through the real SQL loader.
  secretOpenaiKey: `${P}sec-openai-key`,
  connGithub: `${P}conn-github`,
  // A SECOND github connection: with one, per-connection and per-provider
  // decision semantics are indistinguishable — the sibling makes the pg
  // differential falsifiable (block binds to connGithub, not connGithub2).
  connGithub2: `${P}conn-github2`,
  // A calendar connection whose GRANT STACK is authored by the REAL grants
  // compiler below — the enforce test then proves the gateway enforces genuine
  // service output, not hand-mirrored rows.
  connGcal: `${P}conn-gcal`,
} as const;

/** Delete every `gwenf-` row, children before parents. */
const reset = async (): Promise<void> => {
  await db.policyRuleTarget.deleteMany({ where: { id: { startsWith: P } } });
  await db.policyRuleIdentity.deleteMany({ where: { id: { startsWith: P } } });
  await db.policyRuleV2.deleteMany({ where: { id: { startsWith: P } } });
  await db.appConnection.deleteMany({ where: { id: { startsWith: P } } });
  await db.secret.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

const seed = async (): Promise<void> => {
  // Org + the workspace under test + a second workspace as the cross-workspace fence control.
  await db.organization.create({
    data: {
      id: FIXTURE.org,
      name: FIXTURE.org,
      slug: FIXTURE.org,
    },
  });
  await db.workspace.create({
    data: {
      id: FIXTURE.workspace,
      name: FIXTURE.workspace,
      organizationId: FIXTURE.org,
    },
  });
  await db.workspace.create({
    data: {
      id: FIXTURE.workspaceFence,
      name: FIXTURE.workspaceFence,
      organizationId: FIXTURE.org,
    },
  });

  // A realistic agent (plaintext access_token is how the gateway authenticates the
  // proxy request; the in-crate test doesn't authenticate, but keep the graph real).
  await db.agent.create({
    data: {
      id: FIXTURE.agent,
      workspaceId: FIXTURE.workspace,
      name: "gwenf-agent",
      identifier: "gwenf-agent",
      accessToken: "aoc_gwenf_test_token",
    },
  });

  // An OAuth-mode OpenAI secret: enforcement must cover EVERY host its ChatGPT
  // credential injects on, not just the stored one (the Fix-C asymmetry). The
  // authMode metadata is what the gateway's `secret_host_patterns` gates the
  // expansion on (#490). No encrypted value needed — the enforce loaders read
  // only host_pattern/type/scope/metadata, never the ciphertext.
  await db.secret.create({
    data: {
      id: FIXTURE.secretOpenai,
      name: "gwenf openai",
      type: "openai",
      hostPattern: "api.openai.com",
      scope: "workspace",
      workspaceId: FIXTURE.workspace,
      metadata: { authMode: "oauth" },
    },
  });

  // The API-key-mode sibling: same type, same stored host, api-key metadata —
  // its resolved host set must stay exactly ["api.openai.com"].
  await db.secret.create({
    data: {
      id: FIXTURE.secretOpenaiKey,
      name: "gwenf openai key",
      type: "openai",
      hostPattern: "api.openai.com",
      scope: "workspace",
      workspaceId: FIXTURE.workspace,
      metadata: { authMode: "api-key" },
    },
  });

  // TWO GitHub connections: `rule-github-conn` names only the first, so the
  // enforce test can prove the decision binds to the winning connection (the
  // sibling sails past the block).
  await db.appConnection.create({
    data: {
      id: FIXTURE.connGithub,
      provider: "github",
      scope: "workspace",
      status: "connected",
      workspaceId: FIXTURE.workspace,
    },
  });
  await db.appConnection.create({
    data: {
      id: FIXTURE.connGithub2,
      provider: "github",
      scope: "workspace",
      status: "connected",
      workspaceId: FIXTURE.workspace,
    },
  });
  await db.appConnection.create({
    data: {
      id: FIXTURE.connGcal,
      provider: "google-calendar",
      scope: "workspace",
      status: "connected",
      workspaceId: FIXTURE.workspace,
    },
  });

  // Workspace-scope rules, first-match by priority — seeded as DRAFTS (gen 0);
  // the grants-compiler call below publishes the whole draft into generation 1
  // (its atomic write+publish), so the published set is genuine service output
  // rather than hand-written published rows. Each rule carries its target(s)
  // as a nested create. Empty targets on the terminal Default Rule = "any
  // destination".
  const rule = (
    id: string,
    priority: number,
    action: "allow" | "block",
    isDefault: boolean,
    // Typed from Prisma (not hand-rolled) so a renamed/dropped target column is
    // caught at these call sites' object literals, not only at runtime.
    targets: Prisma.PolicyRuleTargetUncheckedCreateWithoutRuleInput[],
    enabled = true,
  ) =>
    db.policyRuleV2.create({
      data: {
        id: `${P}${id}`,
        scope: "workspace",
        workspaceId: FIXTURE.workspace,
        status: "draft",
        generation: 0,
        enabled,
        isDefault,
        source: isDefault ? "default" : "custom",
        priority,
        name: id,
        action,
        targets: targets.length ? { create: targets } : undefined,
      },
    });

  await rule("rule-gmail", 1, "block", false, [
    { id: `${P}t-gmail`, kind: "app", appProvider: "gmail" },
  ]);
  await rule("rule-openai", 2, "block", false, [
    { id: `${P}t-openai`, kind: "secret", secretId: FIXTURE.secretOpenai },
  ]);
  await rule("rule-datadog", 3, "block", false, [
    { id: `${P}t-datadog`, kind: "app", appProvider: "datadog" },
  ]);
  await rule("rule-github-conn", 4, "block", false, [
    {
      id: `${P}t-ghconn`,
      kind: "connection",
      appConnectionId: FIXTURE.connGithub,
    },
  ]);
  await rule("rule-network", 5, "block", false, [
    { id: `${P}t-net`, kind: "network", hostPattern: "blocked.example.com" },
  ]);
  // A DISABLED block rule. The `enabled` filter lives only in the loaders' SQL,
  // so nothing else would notice if that predicate were dropped — and dropping it
  // would silently start enforcing every rule a user had switched off.
  await rule(
    "rule-disabled",
    6,
    "block",
    false,
    [
      {
        id: `${P}t-disabled`,
        kind: "network",
        hostPattern: "disabled.example.com",
      },
    ],
    false,
  );
  await rule("rule-default", 100, "allow", true, []);

  // The calendar grant stack — authored by the REAL compiler (allow
  // list_events, ask create_event; delete_event lands in the blocked
  // complement, everything else in the terminal). Its atomic publish snapshots
  // the ENTIRE draft above into generation 1, so the active published set is
  // exactly what the service produces in production.
  await setConnectionGrant(
    { workspaceId: FIXTURE.workspace, organizationId: FIXTURE.org },
    FIXTURE.agent,
    FIXTURE.connGcal,
    { access: "custom", allow: ["list_events"], ask: ["create_event"] },
    null,
  );

  // The FENCE workspace gets its OWN distinct rule (a block on a host ws-A never
  // mentions), so the cross-workspace isolation test depends on a POPULATED second
  // workspace and can prove isolation in BOTH directions — ws-A's rules don't reach
  // ws-B, and ws-B's rule doesn't reach ws-A.
  await db.policyRuleV2.create({
    data: {
      id: `${P}rule-fence-b`,
      scope: "workspace",
      workspaceId: FIXTURE.workspaceFence,
      status: "published",
      generation: 1,
      enabled: true,
      isDefault: false,
      source: "custom",
      priority: 1,
      name: "rule-fence-b",
      action: "block",
      targets: {
        create: [
          {
            id: `${P}t-fence-b`,
            kind: "network",
            hostPattern: "fence-only.example.com",
          },
        ],
      },
    },
  });
};

const main = async (): Promise<void> => {
  await reset();
  await seed();
  console.log(
    `seeded gateway enforce fixtures (prefix "${P}") into ${FIXTURE.org}/${FIXTURE.workspace}`,
  );
  await db.$disconnect();
};

// Only run when invoked directly (tsx …/gateway-enforce-seed.ts), never on import —
// the module is reachable via `@onecli/api/ee/*`, and importing it must not wipe+reseed.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(async (err: unknown) => {
    console.error("gateway-enforce-seed failed:", err);
    await db.$disconnect();
    process.exit(1);
  });
}
