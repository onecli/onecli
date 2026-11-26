import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * `listSecrets` key-health derivation on REAL PostgreSQL — the Models page's
 * badge signal. Laws: only statuses that indict the key (401/402/403/429)
 * brand it; the latest in-window injected call is the only word (one success
 * clears, old failures age out with the 7-day window); LLM keys only (a
 * generic secret sharing the host never inherits the badge); the log host is
 * matched case-insensitively on any port (the gateway writes the CONNECT
 * authority verbatim); wildcard host patterns are skipped; and the read is
 * workspace-fenced — another workspace's failures never brand this
 * workspace's key (the planted negative control), and an org-scoped list
 * (no workspaceId) derives nothing.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type SecretService = typeof import("./secret-service");

let db: Db;
let secretService: SecretService;

const P = "shl-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const FOREIGN_WORKSPACE = `${P}foreign-ws`;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const reset = async () => {
  await db.requestLog.deleteMany({
    where: { workspaceId: { startsWith: P } },
  });
  await db.secret.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

/** An LLM key (or, with type "generic", a plain secret) in THE workspace.
 * Dated well before any log row the tests write: key health ignores failures
 * logged before the key's last write (they may be a predecessor's), so a key
 * must predate the traffic it is judged by. */
const secretRow = (
  id: string,
  type: string,
  hostPattern: string,
  scope: "workspace" | "organization" = "workspace",
  updatedAt: Date = new Date(Date.now() - 30 * DAY),
) =>
  db.secret.create({
    data: {
      id,
      scope,
      workspaceId: scope === "workspace" ? WORKSPACE : null,
      organizationId: scope === "organization" ? ORG : null,
      name: id,
      type,
      hostPattern,
      encryptedValue: "opaque",
      createdAt: updatedAt,
      updatedAt,
    },
  });

/** An injected upstream call as the gateway logs it (host = CONNECT authority). */
const logRow = (
  host: string,
  status: number,
  createdAt: Date,
  opts: { workspaceId?: string; injectionCount?: number; path?: string } = {},
) =>
  db.requestLog.create({
    data: {
      workspaceId: opts.workspaceId ?? WORKSPACE,
      agentId: `${P}agent`,
      method: "POST",
      host,
      path: opts.path ?? "/v1/messages",
      provider: "custom",
      status,
      latencyMs: 12,
      injectionCount: opts.injectionCount ?? 1,
      createdAt,
    },
  });

const listForWorkspace = async () => {
  const rows = await secretService.listSecrets({
    workspaceId: WORKSPACE,
    organizationId: ORG,
  });
  return new Map(rows.map((r) => [r.id, r]));
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  secretService = await import("./secret-service");
  await reset();

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
});

describe.skipIf(!PROOF_URL)(
  "listSecrets key health over real PostgreSQL",
  () => {
    it("brands the key when the latest in-window injected call failed with 401", async () => {
      const at = new Date(Date.now() - 1 * HOUR);
      await secretRow(`${P}s1`, "anthropic", "c1.api.test");
      await logRow("c1.api.test", 401, at);

      const rows = await listForWorkspace();
      expect(rows.get(`${P}s1`)?.lastError).toEqual({ status: 401, at });
    });

    it("a key added after the host's last failure starts clean", async () => {
      // The 401 belongs to whatever key served this host before; this key's
      // value was saved afterwards and has not failed.
      await logRow("fresh.api.test", 401, new Date(Date.now() - 2 * HOUR));
      await secretRow(
        `${P}fresh`,
        "anthropic",
        "fresh.api.test",
        "workspace",
        new Date(Date.now() - 1 * HOUR),
      );

      const rows = await listForWorkspace();
      expect(rows.get(`${P}fresh`)?.lastError).toBeNull();
    });

    it("ignores side endpoints a runtime polls with a good key", async () => {
      // Claude Code polls /api/oauth/usage at boot; Anthropic answers 403 for
      // working keys. A later usage 403 must not hide the last real call.
      const ok = new Date(Date.now() - 2 * HOUR);
      await secretRow(`${P}side`, "anthropic", "side.api.test");
      await logRow("side.api.test", 200, ok);
      await logRow("side.api.test", 403, new Date(Date.now() - 1 * HOUR), {
        path: "/api/oauth/usage",
      });

      const rows = await listForWorkspace();
      expect(rows.get(`${P}side`)?.lastError).toBeNull();
    });

    it("brands an OAuth-mode OpenAI key on its Codex inference path", async () => {
      // Codex signed in with ChatGPT calls chatgpt.com/backend-api/codex/…,
      // not /v1/…; a 401 there is the key's own failure and must still show.
      const at = new Date(Date.now() - 1 * HOUR);
      await secretRow(`${P}codex`, "openai", "codex.chat.test");
      await logRow("codex.chat.test:443", 401, at, {
        path: "/backend-api/codex/responses",
      });

      const rows = await listForWorkspace();
      expect(rows.get(`${P}codex`)?.lastError).toEqual({ status: 401, at });
    });

    it.each([402, 403, 429])(
      "brands the key on %i too — payment and limits indict it like auth",
      async (status) => {
        const at = new Date(Date.now() - 1 * HOUR);
        await secretRow(`${P}s${status}`, "anthropic", `c${status}.api.test`);
        await logRow(`c${status}.api.test`, status, at);

        const rows = await listForWorkspace();
        expect(rows.get(`${P}s${status}`)?.lastError).toEqual({ status, at });
      },
    );

    it("a latest 500 clears an older brand — server errors don't indict the key", async () => {
      await secretRow(`${P}s500`, "anthropic", "c500.api.test");
      await logRow("c500.api.test", 401, new Date(Date.now() - 2 * HOUR));
      await logRow("c500.api.test", 500, new Date(Date.now() - 1 * HOUR));

      const rows = await listForWorkspace();
      expect(rows.get(`${P}s500`)?.lastError).toBeNull();
    });

    it("clears on the next successful call — the latest word wins", async () => {
      await secretRow(`${P}s2`, "anthropic", "c2.api.test");
      await logRow("c2.api.test", 401, new Date(Date.now() - 2 * HOUR));
      await logRow("c2.api.test", 200, new Date(Date.now() - 1 * HOUR));

      const rows = await listForWorkspace();
      expect(rows.get(`${P}s2`)?.lastError).toBeNull();
    });

    it("ignores statuses that don't indict the key (a plain 400)", async () => {
      await secretRow(`${P}s3`, "anthropic", "c3.api.test");
      await logRow("c3.api.test", 400, new Date(Date.now() - 1 * HOUR));

      const rows = await listForWorkspace();
      expect(rows.get(`${P}s3`)?.lastError).toBeNull();
    });

    it("ages a failure out with the 7-day window", async () => {
      await secretRow(`${P}s4`, "anthropic", "c4.api.test");
      await logRow("c4.api.test", 429, new Date(Date.now() - 8 * DAY));

      const rows = await listForWorkspace();
      expect(rows.get(`${P}s4`)?.lastError).toBeNull();
    });

    it("never brands a generic secret, even one sharing the failing LLM host", async () => {
      const at = new Date(Date.now() - 1 * HOUR);
      await secretRow(`${P}s5-llm`, "anthropic", "c5.api.test");
      await secretRow(`${P}s5-generic`, "generic", "c5.api.test");
      await logRow("c5.api.test", 429, at);

      const rows = await listForWorkspace();
      expect(rows.get(`${P}s5-llm`)?.lastError).toEqual({ status: 429, at });
      expect(rows.get(`${P}s5-generic`)?.lastError).toBeNull();
    });

    it("matches the logged CONNECT authority case-insensitively and on any port", async () => {
      const at443 = new Date(Date.now() - 1 * HOUR);
      const at8443 = new Date(Date.now() - 2 * HOUR);
      await secretRow(`${P}s6a`, "anthropic", "c6a.api.test");
      await secretRow(`${P}s6b`, "openai", "c6b.api.test");
      await logRow("C6A.API.Test:443", 429, at443);
      await logRow("c6b.api.test:8443", 401, at8443);

      const rows = await listForWorkspace();
      expect(rows.get(`${P}s6a`)?.lastError).toEqual({
        status: 429,
        at: at443,
      });
      expect(rows.get(`${P}s6b`)?.lastError).toEqual({
        status: 401,
        at: at8443,
      });
    });

    it("does not match a different host that merely shares a prefix", async () => {
      await secretRow(`${P}s6c`, "anthropic", "c6.api.test");
      await logRow("c6.api.test.evil.example:443", 401, new Date());

      const rows = await listForWorkspace();
      expect(rows.get(`${P}s6c`)?.lastError).toBeNull();
    });

    it("never reads another workspace's traffic (cross-workspace control)", async () => {
      await secretRow(`${P}s7`, "anthropic", "c7.api.test");
      await logRow("c7.api.test", 401, new Date(Date.now() - 1 * HOUR), {
        workspaceId: FOREIGN_WORKSPACE,
      });

      const rows = await listForWorkspace();
      expect(rows.get(`${P}s7`)?.lastError).toBeNull();
    });

    it("derives nothing for an org-scoped list (no workspace to read logs from)", async () => {
      const at = new Date(Date.now() - 1 * HOUR);
      await secretRow(`${P}s8`, "anthropic", "c8.api.test", "organization");
      await logRow("c8.api.test", 401, at);

      const orgRows = await secretService.listSecrets({ organizationId: ORG });
      const orgRow = orgRows.find((r) => r.id === `${P}s8`);
      expect(orgRow?.lastError).toBeNull();

      // The same org key listed FROM a workspace shows that workspace's traffic.
      const wsRows = await listForWorkspace();
      expect(wsRows.get(`${P}s8`)?.lastError).toEqual({ status: 401, at });
    });

    it("ignores calls that injected nothing", async () => {
      await secretRow(`${P}s9`, "anthropic", "c9.api.test");
      await logRow("c9.api.test", 401, new Date(Date.now() - 1 * HOUR), {
        injectionCount: 0,
      });

      const rows = await listForWorkspace();
      expect(rows.get(`${P}s9`)?.lastError).toBeNull();
    });

    it("skips wildcard host patterns (equality can never match them)", async () => {
      await secretRow(`${P}s10`, "anthropic", "*.c10.test");
      await logRow("x.c10.test", 401, new Date(Date.now() - 1 * HOUR));

      const rows = await listForWorkspace();
      expect(rows.get(`${P}s10`)?.lastError).toBeNull();
    });

    it("skips LIKE-metacharacter host patterns — a stored % must not pattern-match other hosts' rows", async () => {
      // Prisma's insensitive/startsWith filters compile to ILIKE without
      // escaping the value. MUTATION-PROOF: drop the metacharacter skip and
      // the % pattern matches the foreign host's 401 below, branding a key
      // whose real host never failed.
      await secretRow(`${P}s11`, "anthropic", "c11%test");
      await logRow("c11-other-host-test", 401, new Date(Date.now() - 1 * HOUR));

      const rows = await listForWorkspace();
      expect(rows.get(`${P}s11`)?.lastError).toBeNull();
    });
  },
);
