import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The legacy → v2 conversion on REAL PostgreSQL — the committed end-to-end
 * proof of the boot pass: translate → one atomic published generation per
 * project → verify, plus idempotency, the divergence posture (the generation is
 * KEPT — deleting it would enforce nothing, see migrate.ts), preempt detection,
 * and cross-project isolation.
 *
 * Env-gated: skipped unless POLICY_PROOF_DATABASE_URL points at a migrated
 * PostgreSQL 16, e.g.
 *
 *   docker run -d --name oss-proof-pg -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=onecli -p 5440:5432 postgres:16-alpine
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5440/onecli" \
 *     pnpm --filter @onecli/db prisma migrate deploy
 *   POLICY_PROOF_DATABASE_URL="postgresql://postgres:postgres@localhost:5440/onecli" \
 *     pnpm --filter @onecli/api test -- --run src/ee/services/policy-oss-cutover.pg.test.ts
 *
 * When running BOTH pg suites in one invocation, add --no-file-parallelism:
 * they share the one proof database, and this suite's boot walk iterates
 * every org — concurrent files would interleave.
 */

const PROOF_URL = process.env.POLICY_PROOF_DATABASE_URL;

// Dynamic imports throughout: @onecli/db builds its client from DATABASE_URL
// at import time, so the env must be staged first.
type Db = typeof import("@onecli/db").db;
type CutoverModule = typeof import("./migrate");

let db: Db;
let cutover: CutoverModule;

const ids = {
  orgDeny: "oss-proof-org-deny",
  orgAllow: "oss-proof-org-allow",
  p1: "ossproofproj1xxx",
  p2: "ossproofproj2xxx",
  p3: "ossproofproj3xxx",
  p4: "ossproofproj4xxx",
  agentSel: "oss-proof-agent-sel",
  agentAll: "oss-proof-agent-all",
  secret1: "oss-proof-secret-1",
  secret2: "oss-proof-secret-2",
  secretOrg: "oss-proof-secret-org",
  conn1: "oss-proof-conn-1",
  p5: "ossproofproj5xxx",
} as const;

const wipe = async () => {
  await db.policyRuleV2.deleteMany({
    where: { projectId: { in: [ids.p1, ids.p2, ids.p3, ids.p4, ids.p5] } },
  });
  await db.policyRule.deleteMany({
    where: { projectId: { in: [ids.p1, ids.p2, ids.p3, ids.p4, ids.p5] } },
  });
  await db.agentSecret.deleteMany({
    where: { agentId: { in: [ids.agentSel, ids.agentAll] } },
  });
  await db.agentAppConnection.deleteMany({
    where: { agentId: { in: [ids.agentSel, ids.agentAll] } },
  });
  await db.agent.deleteMany({
    where: { id: { in: [ids.agentSel, ids.agentAll] } },
  });
  await db.appConnection.deleteMany({ where: { id: ids.conn1 } });
  await db.secret.deleteMany({
    where: { id: { in: [ids.secret1, ids.secret2, ids.secretOrg] } },
  });
  await db.project.deleteMany({
    where: { id: { in: [ids.p1, ids.p2, ids.p3, ids.p4, ids.p5] } },
  });
  await db.organization.deleteMany({
    where: { id: { in: [ids.orgDeny, ids.orgAllow] } },
  });
};

const oldRule = (
  projectId: string,
  name: string,
  over: Record<string, unknown> = {},
) =>
  db.policyRule.create({
    data: {
      name,
      projectId,
      hostPattern: "api.example.com",
      action: "allow",
      enabled: true,
      ...over,
    },
  });

describe.skipIf(!PROOF_URL)(
  "the legacy → v2 migration on real PostgreSQL",
  () => {
    beforeAll(async () => {
      process.env.DATABASE_URL = PROOF_URL;
      process.env.EDITION = "oss";
      ({ db } = await import("@onecli/db"));
      cutover = await import("./migrate");

      await wipe();
      await db.organization.create({
        data: {
          id: ids.orgDeny,
          name: "OSS Proof Deny",
          slug: "oss-proof-deny",
          policyMode: "deny",
        },
      });
      await db.organization.create({
        data: {
          id: ids.orgAllow,
          name: "OSS Proof Allow",
          slug: "oss-proof-allow",
          policyMode: "allow",
        },
      });
      for (const [pid, org] of [
        [ids.p1, ids.orgDeny],
        [ids.p2, ids.orgAllow],
      ] as const) {
        await db.project.create({
          data: {
            id: pid,
            name: `proof-${pid}`,
            slug: `proof-${pid}`,
            organizationId: org,
          },
        });
      }

      // Equipment: a selective agent with one secret + one connection (with a
      // stored sessionPolicy that must be dropped), and an all-mode agent.
      await db.secret.create({
        data: {
          id: ids.secret1,
          name: "s1",
          type: "generic",
          encryptedValue: "v",
          hostPattern: "api.example.com",
          projectId: ids.p1,
        },
      });
      await db.secret.create({
        data: {
          id: ids.secret2,
          name: "s2",
          type: "generic",
          encryptedValue: "v",
          hostPattern: "api.example.com",
          projectId: ids.p1,
        },
      });
      await db.appConnection.create({
        data: {
          id: ids.conn1,
          provider: "github",
          projectId: ids.p1,
          status: "active",
        },
      });
      await db.agent.create({
        data: {
          id: ids.agentSel,
          name: "sel",
          identifier: "oss-proof-sel",
          accessToken: "oss-proof-token-sel",
          projectId: ids.p1,
          secretMode: "selective",
        },
      });
      await db.agent.create({
        data: {
          id: ids.agentAll,
          name: "all",
          identifier: "oss-proof-all",
          accessToken: "oss-proof-token-all",
          projectId: ids.p1,
          secretMode: "all",
        },
      });
      await db.secret.create({
        data: {
          id: ids.secretOrg,
          name: "s-org",
          type: "generic",
          encryptedValue: "v",
          hostPattern: "org.example.com",
          scope: "organization",
          organizationId: ids.orgDeny,
        },
      });
      await db.agentSecret.create({
        data: { agentId: ids.agentSel, secretId: ids.secret1 },
      });
      await db.agentSecret.create({
        data: { agentId: ids.agentSel, secretId: ids.secretOrg },
      });
      await db.agentAppConnection.create({
        data: {
          agentId: ids.agentSel,
          appConnectionId: ids.conn1,
          sessionPolicy: { repositories: ["o/r"] },
        },
      });
      await db.agentSecret.create({
        data: { agentId: ids.agentAll, secretId: ids.secret2 },
      });

      // P1's legacy state: the full shape zoo.
      await oldRule(ids.p1, "agent allow", { agentId: ids.agentSel });
      await oldRule(ids.p1, "any block", {
        action: "block",
        pathPattern: "/admin/*",
      });
      await oldRule(ids.p1, "rate", {
        action: "rate_limit",
        rateLimit: 10,
        rateLimitWindow: "hour",
      });
      await oldRule(ids.p1, "approval", { action: "manual_approval" });
      await oldRule(ids.p1, "disabled custom", { enabled: false });
      await oldRule(ids.p1, "malformed rate", {
        action: "rate_limit",
        rateLimit: 0,
      });
      await oldRule(ids.p1, "conditioned", {
        action: "block",
        conditions: [{ target: "body", operator: "contains", value: "drop" }],
      });
      await oldRule(ids.p1, "gmail send tool", {
        hostPattern: "gmail.googleapis.com",
        pathPattern: "/gmail/v1/users/*/messages/send",
        method: "POST",
        action: "block",
        metadata: {
          source: "app_permission",
          provider: "gmail",
          toolId: "send_email",
        },
      });
      await oldRule(ids.p1, "gmail read tool", {
        hostPattern: "gmail.googleapis.com",
        pathPattern: "/gmail/v1/users/*/messages",
        method: "GET",
        action: "block",
        metadata: {
          source: "app_permission",
          provider: "gmail",
          toolId: "read_email",
        },
      });
      await oldRule(ids.p1, "blocklist on", {
        hostPattern: "uploads.github.com",
        action: "block",
        metadata: {
          source: "app_permission",
          type: "blocklist",
          provider: "github",
          hostId: "uploads",
        },
      });
      await oldRule(ids.p1, "blocklist off", {
        hostPattern: "objects.github.com",
        action: "block",
        enabled: false,
        metadata: {
          source: "app_permission",
          type: "blocklist",
          provider: "github",
          hostId: "objects",
        },
      });

      // P2 (allow org): one custom rule — the isolation control.
      await oldRule(ids.p2, "p2 custom", { action: "block" });
    }, 60_000);

    afterAll(async () => {
      await wipe();
      await db.$disconnect();
    });

    const published = async (projectId: string) => {
      // The ACTIVE generation only (max published), like the gateway's loader —
      // a republish adds a new generation and retains the old ones.
      const max = await db.policyRuleV2.aggregate({
        where: { scope: "project", projectId, status: "published" },
        _max: { generation: true },
      });
      if (max._max.generation === null) return [];
      return db.policyRuleV2.findMany({
        where: {
          scope: "project",
          projectId,
          status: "published",
          generation: max._max.generation,
        },
        include: { identities: true, targets: true },
        orderBy: [{ priority: "asc" }, { id: "asc" }],
      });
    };

    it("cuts every project over in one atomic verified generation", async () => {
      await cutover.runLegacyPolicyMigration();

      const p1 = await published(ids.p1);
      // 8 policy rows collapse to 7 policy rules (agent allow, any block, rate,
      // approval, disabled custom, conditioned, and the TWO gmail tool rows
      // GROUPED into one — step 9.9) + 1 blocklist + 3 equipment (project secret
      // + ORG-scoped secret + connection — the org-scoped one is the shape the
      // legacy join injected scope-blind) + default. Malformed rate and the
      // disabled blocklist are dropped.
      expect(p1).toHaveLength(12);
      expect(p1.every((r) => r.generation === 1)).toBe(true); // the initial cut

      const byName = new Map(p1.map((r) => [r.name, r]));
      expect(byName.get("Default Rule")?.action).toBe("block"); // deny org
      expect(byName.get("Default Rule")?.isDefault).toBe(true);
      expect(byName.get("Default Rule")?.description).toContain("Migrated");
      // The two gmail tool rows group into one adopted rule named for the app
      // (block suffix), carrying both endpoints verbatim.
      const gmail = byName.get("Gmail (blocked)");
      expect(gmail?.source).toBe("custom"); // adopted + grouped
      expect(gmail?.targets).toHaveLength(2);
      expect(byName.has("gmail send tool")).toBe(false);
      expect(byName.get("blocklist on")?.source).toBe("blocklist");
      expect(byName.get("disabled custom")?.enabled).toBe(false);
      expect(byName.has("malformed rate")).toBe(false);
      expect(byName.has("blocklist off")).toBe(false);
      expect(byName.get("conditioned")?.conditions).toEqual([
        { target: "body", operator: "contains", value: "drop" },
      ]);

      // Equipment: the selective agent's secret + connection, sessionPolicy
      // DROPPED; the all-mode agent derives nothing.
      const equipment = p1.filter((r) => r.source === "equipment");
      expect(equipment).toHaveLength(3);
      // The ORG-scoped assignment survived the cutover (no silent drop).
      expect(
        equipment.some((r) =>
          r.targets.some((t) => t.secretId === ids.secretOrg),
        ),
      ).toBe(true);
      expect(equipment.every((r) => r.conditions === null)).toBe(true);
      expect(
        equipment.every((r) => r.identities[0]?.agentId === ids.agentSel),
      ).toBe(true);

      // Ordering law: agent-scoped first, then strictness among all-agents.
      const policyNames = p1
        .filter((r) => r.source === "custom" || r.source === "blocklist")
        .map((r) => r.name);
      expect(policyNames[0]).toBe("agent allow"); // identity dominance
      expect(policyNames.indexOf("any block")).toBeLessThan(
        policyNames.indexOf("rate"),
      );
      expect(policyNames.indexOf("approval")).toBeLessThan(
        policyNames.indexOf("rate"), // strictness: approval(1) before rate(2)
      );

      // The allow-org project: default Allow.
      const p2 = await published(ids.p2);
      expect(p2.find((r) => r.isDefault)?.action).toBe("allow");
    }, 60_000);

    it("is idempotent — a re-run leaves one generation, byte-stable", async () => {
      const before = await published(ids.p1);
      await cutover.runLegacyPolicyMigration();
      const after = await published(ids.p1);
      expect(after.map((r) => r.id).sort()).toEqual(
        before.map((r) => r.id).sort(),
      );
      expect(new Set(after.map((r) => r.generation))).toEqual(new Set([1]));
    }, 60_000);

    it("a diverged project KEEPS its generation — deleting it would enforce nothing", async () => {
      // A fresh project the full run has NOT cut (created after it ran).
      await db.project.create({
        data: {
          id: ids.p3,
          name: "proof-p3",
          slug: "proof-p3",
          organizationId: ids.orgDeny,
        },
      });
      await oldRule(ids.p3, "p3 rule", { action: "block" });
      // Inject a verify fault: a fresh module graph where the canon lies.
      vi.resetModules();
      vi.doMock("./translate", async (importOriginal) => {
        const real = await importOriginal<typeof import("./translate")>();
        let n = 0;
        return {
          ...real,
          // Alternate canons so stored-vs-expected can never agree.
          ossCanonRule: (r: unknown) =>
            `${real.ossCanonRule(r as never)}::${n++ % 2}`,
        };
      });
      const faulted = await import("./migrate");
      const result = await faulted.cutoverOssProject(ids.p3, "deny");
      vi.doUnmock("./translate");
      vi.resetModules();
      // Re-import the clean modules for any later use.
      cutover = await import("./migrate");

      expect(result.status).toBe("diverged");
      // Before step 10 this compensated by DELETING the v2 rows, because "no
      // published generation" meant the gateway fell back to the legacy engine.
      // That fallback is gone — an empty rule set decides Allow — so the written
      // generation must survive, enforcing the translation rather than nothing.
      const kept = await published(ids.p3);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.some((r) => r.isDefault && r.action === "block")).toBe(true);
      // A later boot is a no-op: the generation exists, so it is not re-cut and
      // not reported as preempted (it carries the migration marker).
      const retry = await cutover.cutoverOssProject(ids.p3, "deny");
      expect(retry.status).toBe("skipped");
      expect(retry.preempted).toBeUndefined();
    }, 60_000);

    it("a user publish that pre-empted migration is detected as preempted", async () => {
      await db.project.create({
        data: {
          id: ids.p5,
          name: "proof-p5",
          slug: "proof-p5",
          organizationId: ids.orgDeny,
        },
      });
      await oldRule(ids.p5, "p5 legacy rule", { action: "block" });
      // Simulate the race: a user-authored generation lands BEFORE the migrator
      // (an ensureDefault'd allow default with no migration marker).
      await db.policyRuleV2.create({
        data: {
          scope: "project",
          projectId: ids.p5,
          status: "published",
          generation: 1,
          priority: 0,
          enabled: true,
          isDefault: true,
          source: "default",
          name: "Default Rule",
          action: "allow",
          requireApproval: false,
        },
      });
      const result = await cutover.cutoverOssProject(ids.p5, "deny");
      expect(result.status).toBe("skipped");
      expect(result.preempted).toBe(true);
    }, 60_000);

    // ── What the conversion actually DOES, not what it wrote ────────────────
    //
    // Every other assertion here is about ROWS: the right count, the right
    // order, the right canonical form. None of them would notice a conversion
    // that produced a well-formed generation with the wrong meaning. The
    // old-vs-new parity that used to cover that (the production shadow bake and
    // the translation oracle) retired with the old engine, so this drives the
    // converted policy through the real evaluator and asserts DECISIONS.

    /** Decide a request against P1's converted, published policy — the same
     * composition `policy-simulate` uses in production. Every OSS-translated
     * rule is a network rule, so the secret-host and provider maps are empty. */
    const decideOnP1 = async (req: {
      host: string;
      path: string;
      method?: string;
      body?: string;
      hasInjections?: boolean;
      isLlmHost?: boolean;
      agentId?: string;
    }) => {
      const { loadRulesForSimulation } =
        await import("../policy-simulate/load-rules");
      const { toSimRule } = await import("../policy-simulate/sim-rule");
      const { evaluatePolicyOutcome } =
        await import("../policy-translation/evaluator");
      const rows = await loadRulesForSimulation(
        { scope: "project", projectId: ids.p1 },
        "published",
      );
      const rules = rows.map(
        (r) =>
          toSimRule(
            r,
            { byId: new Map(), projectHosts: [], orgHosts: [] },
            new Map(),
          ).rule,
      );
      return evaluatePolicyOutcome(rules, {
        host: req.host,
        path: req.path,
        method: req.method ?? "GET",
        body: req.body,
        // Default to the agent NO rule names, so each assertion isolates the
        // rule under test. `agentSel` carries a whole-host agent-scoped allow;
        // pointing these at it would instead exercise the documented
        // agent-shadow divergence (plan §7.7 case (a)), which is not what this
        // suite is for — the dedicated case below covers that.
        agentId: req.agentId ?? ids.agentAll,
        hasInjections: req.hasInjections ?? false,
        isLlmHost: req.isLlmHost ?? false,
      });
    };

    it("BEHAVIOUR: an explicit legacy block still blocks its path glob", async () => {
      const out = await decideOnP1({
        host: "api.example.com",
        path: "/admin/users",
      });
      expect(out.kind).toBe("rule");
      expect(out.kind === "rule" && out.rule.action).toBe("block");
    });

    it("BEHAVIOUR: an ENABLED legacy blocklist host still blocks", async () => {
      const out = await decideOnP1({ host: "uploads.github.com", path: "/x" });
      expect(out.kind === "rule" && out.rule.action).toBe("block");
    });

    it("BEHAVIOUR: a DISABLED legacy rule did not start enforcing", async () => {
      // The failure this catches: converting `enabled: false` into a live rule
      // would silently begin blocking traffic the operator had switched off.
      const out = await decideOnP1({ host: "objects.github.com", path: "/x" });
      expect(out.kind).not.toBe("rule");
    });

    it("BEHAVIOUR: an app-permission tool rule blocks ITS endpoint only", async () => {
      const send = await decideOnP1({
        host: "gmail.googleapis.com",
        path: "/gmail/v1/users/me/messages/send",
        method: "POST",
      });
      expect(send.kind === "rule" && send.rule.action).toBe("block");
      // A sibling endpoint the rule never named must stay open — proving the
      // tool rule did not over-broaden to the whole host on conversion.
      const other = await decideOnP1({
        host: "gmail.googleapis.com",
        path: "/gmail/v1/users/me/labels",
      });
      expect(other.kind).not.toBe("rule");
    });

    it("BEHAVIOUR: a condition survived — it gates the block, both ways", async () => {
      const hit = await decideOnP1({
        host: "api.example.com",
        path: "/anything",
        body: "please drop the table",
      });
      expect(hit.kind === "rule" && hit.rule.action).toBe("block");
      const miss = await decideOnP1({
        host: "api.example.com",
        path: "/anything",
        body: "harmless",
      });
      expect(miss.kind === "rule" && miss.rule.action).not.toBe("block");
    });

    it("BEHAVIOUR: the agent-scoped allow still shadows, for its agent only", async () => {
      // The legacy agent-override survived the conversion as per-identity
      // priority: for the named agent the whole-host allow wins over the
      // all-agents `/admin/*` block; for any other agent the block stands.
      const named = await decideOnP1({
        host: "api.example.com",
        path: "/admin/users",
        agentId: ids.agentSel,
      });
      expect(named.kind === "rule" && named.rule.action).toBe("allow");
      const other = await decideOnP1({
        host: "api.example.com",
        path: "/admin/users",
        agentId: ids.agentAll,
      });
      expect(other.kind === "rule" && other.rule.action).toBe("block");
    });

    it("BEHAVIOUR: the org's deny posture became an enforced deny-default", async () => {
      // policyMode "deny" → the project Default Rule blocks, under the carve.
      const denied = await decideOnP1({
        host: "unmentioned.example.org",
        path: "/x",
        hasInjections: true,
      });
      expect(denied.kind).toBe("denyDefault");
      // …and the carve still holds: no injected credential → no deny-default.
      const carved = await decideOnP1({
        host: "unmentioned.example.org",
        path: "/x",
        hasInjections: false,
      });
      expect(carved.kind).not.toBe("denyDefault");
      // …nor on an LLM host, even with a credential injected.
      const llm = await decideOnP1({
        host: "unmentioned.example.org",
        path: "/x",
        hasInjections: true,
        isLlmHost: true,
      });
      expect(llm.kind).not.toBe("denyDefault");
    });

    it("cross-project isolation: P1's churn never touched P2", async () => {
      const p2 = await published(ids.p2);
      expect(p2.map((r) => r.name).sort()).toEqual(
        ["Default Rule", "p2 custom"].sort(),
      );
    });
  },
);
