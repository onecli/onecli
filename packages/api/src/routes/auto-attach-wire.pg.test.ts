/**
 * Acceptance walk for the workspace auto-attach over the REAL public
 * interfaces: the `/v1` routes the dashboard, the CLI and the SDK call,
 * through `createApiApp` with a signed-in workspace owner, on real
 * PostgreSQL. It plays the story a user lives through:
 *
 *  1. Two agents exist; the user connects an app (POST /v1/apps/:p/connect).
 *     Both agents read the new account as a full-access grant, and the
 *     credential reflection (built on the PUBLISHED rule set, the one the
 *     gateway enforces) lists it as injectable for both.
 *  2. A custom secret (POST /v1/secrets) reaches both agents; the response's
 *     `attachedAgents` says so.
 *  3. One agent runs on OpenAI on purpose. A new Anthropic key goes only to
 *     the agent with no key; the OpenAI agent keeps exactly its one key.
 *  4. A new agent (POST /v1/agents) starts with the connection and the
 *     custom secret, but not with the LLM keys of the configured agents'
 *     choice (it gets the workspace keys through the pre-existing LLM rule).
 *  5. The user narrows one agent; a re-connect (same account) changes
 *     nothing, a detach sticks.
 *  6. Deleting an agent (DELETE /v1/agents/:id) leaves no rule applying to
 *     every agent, and the sibling's access is exactly what it was.
 *  7. Planted controls: an org-scoped secret (POST /v1/org/secrets) and an
 *     agent of ANOTHER workspace are never touched.
 *
 * The service-level laws (one publish, add-only, fencing, deadlock, the
 * migration) are proven row by row in `workspace-autoattach-service.pg.test`;
 * this suite proves what a caller of the API observes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;

const P = "aawire-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OTHER_WORKSPACE = `${P}other-ws`;
const OWNER = `${P}owner`;
const FOREIGN_AGENT = `${P}foreign-agent`;
const SELF_URL = "https://api.aawire.test";

let currentSession: { id: string; email: string } | null = null;
const inWorkspace = { "x-workspace-id": WORKSPACE };

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: {
      ...inWorkspace,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text ? (JSON.parse(text) as unknown) : null,
  };
};

interface Grants {
  connections: { connectionId: string; access: string }[];
  secrets: { secretId: string }[];
}
interface Effective {
  connections: { id: string }[];
  secrets: { id: string }[];
}

const grantsOf = async (agentId: string) => {
  const res = await call("GET", `/v1/agents/${agentId}/grants`);
  expect(res.status).toBe(200);
  const g = res.json as Grants;
  return {
    connections: g.connections
      .map((c) => `${c.connectionId}:${c.access}`)
      .sort(),
    secrets: g.secrets.map((s) => s.secretId).sort(),
  };
};

/** What the gateway will inject for the agent: the reflection reads the
 * PUBLISHED rule set with the same selection as `inject_select.rs`. */
const injectableFor = async (agentId: string) => {
  const res = await call("GET", `/v1/agents/${agentId}/effective-credentials`);
  expect(res.status).toBe(200);
  const e = res.json as Effective;
  return {
    connections: e.connections.map((c) => c.id).sort(),
    secrets: e.secrets.map((s) => s.id).sort(),
  };
};

const createAgent = async (identifier: string) => {
  const res = await call("POST", "/v1/agents", {
    name: identifier,
    identifier,
  });
  expect(res.status).toBe(201);
  return res.json as { id: string; llmKeys: string[] };
};

const createSecret = async (
  path: "/v1/secrets" | "/v1/org/secrets",
  input: Record<string, unknown>,
) => {
  const res = await call("POST", path, input);
  expect(res.status).toBe(201);
  return res.json as { id: string; attachedAgents?: string[] };
};

const cleanup = async () => {
  const scoped = {
    OR: [
      { workspaceId: { in: [WORKSPACE, OTHER_WORKSPACE] } },
      { organizationId: ORG },
    ],
  };
  await db.policyRuleV2.deleteMany({ where: scoped });
  // By user too: the org-secret write audits at org scope, with no workspace.
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { workspaceId: { in: [WORKSPACE, OTHER_WORKSPACE] } },
        { userId: OWNER },
      ],
    },
  });
  await db.appConnection.deleteMany({ where: scoped });
  await db.secret.deleteMany({ where: scoped });
  await db.agent.deleteMany({
    where: { workspaceId: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.workspaceAccess.deleteMany({
    where: { workspaceId: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: OWNER } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  // Hermetic: the connect route's metadata lookup and the gateway cache
  // flush are outbound calls this walk must not make.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
  ({ db } = await import("@onecli/db"));
  const providers = await import("../providers");
  providers.initSelfUrl(SELF_URL);
  const { createApiApp } = await import("../app");
  app = createApiApp(
    { getSession: async () => currentSession },
    { selfUrl: SELF_URL },
  );

  await cleanup();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
    await db.workspace.create({ data: { id, name: id, organizationId: ORG } });
  }
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.com`,
      externalAuthId: OWNER,
      name: "Olive Owner",
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: OWNER,
      userEmail: `${OWNER}@example.com`,
      role: "owner",
    },
  });
  await db.workspaceAccess.create({
    data: { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
  });
  await db.agent.create({
    data: {
      id: FOREIGN_AGENT,
      identifier: FOREIGN_AGENT,
      name: "Foreign",
      workspaceId: OTHER_WORKSPACE,
      accessToken: `aoc_${FOREIGN_AGENT}`,
    },
  });
  currentSession = { id: OWNER, email: `${OWNER}@example.com` };
});

afterAll(async () => {
  if (!PROOF_URL) return;
  vi.unstubAllGlobals();
  await cleanup();
});

describe.skipIf(!PROOF_URL)(
  "a workspace's new resources, as the API's callers see them",
  () => {
    it("auto-attaches on create, never re-points an LLM agent, and an agent delete leaves no 'everyone' rule", async () => {
      // ── Two agents, one deliberately on OpenAI.
      const alpha = await createAgent(`${P}alpha`);
      const beta = await createAgent(`${P}beta`);
      expect(alpha.llmKeys).toEqual([]);
      const openai = await createSecret("/v1/secrets", {
        name: "OpenAI",
        type: "openai",
        value: "sk-openai-wire",
        hostPattern: "api.openai.com",
      });
      // The first LLM key goes to every agent that had none: both.
      expect([...(openai.attachedAgents ?? [])].sort()).toEqual(
        [alpha.id, beta.id].sort(),
      );
      // Beta is narrowed to no LLM key; alpha keeps OpenAI on purpose.
      expect(
        (
          await call(
            "DELETE",
            `/v1/agents/${beta.id}/grants/secrets/${openai.id}`,
          )
        ).status,
      ).toBe(204);

      // ── 1. Connect an app.
      const connect = await call("POST", "/v1/apps/resend/connect", {
        fields: { apiKey: "re_wire_key" },
        label: "mail@aawire.test",
      });
      expect(connect.status).toBe(200);
      const connectionId = (connect.json as { connection: { id: string } })
        .connection.id;
      for (const agent of [alpha, beta]) {
        expect((await grantsOf(agent.id)).connections).toEqual([
          `${connectionId}:full`,
        ]);
        expect((await injectableFor(agent.id)).connections).toEqual([
          connectionId,
        ]);
      }

      // ── 2. A custom secret reaches every agent.
      const custom = await createSecret("/v1/secrets", {
        name: "Custom API",
        type: "generic",
        value: "custom-wire-value",
        hostPattern: "api.example.com",
        injectionConfig: { headerName: "x-api-key" },
      });
      expect([...(custom.attachedAgents ?? [])].sort()).toEqual(
        [alpha.id, beta.id].sort(),
      );
      expect((await injectableFor(alpha.id)).secrets).toContain(custom.id);
      expect((await injectableFor(beta.id)).secrets).toContain(custom.id);

      // ── 3. A new Anthropic key: only the keyless agent gets it.
      const anthropic = await createSecret("/v1/secrets", {
        name: "Anthropic",
        type: "anthropic",
        value: "sk-ant-wire",
        hostPattern: "api.anthropic.com",
      });
      expect(anthropic.attachedAgents).toEqual([beta.id]);
      expect((await grantsOf(alpha.id)).secrets).toEqual(
        [openai.id, custom.id].sort(),
      );
      expect((await grantsOf(beta.id)).secrets).toEqual(
        [anthropic.id, custom.id].sort(),
      );

      // ── 7a. Planted control: an ORG secret attaches to nothing.
      const orgSecret = await createSecret("/v1/org/secrets", {
        name: "Org API",
        type: "generic",
        value: "org-wire-value",
        hostPattern: "api.example.org",
        injectionConfig: { headerName: "x-org-key" },
      });
      expect((await grantsOf(alpha.id)).secrets).not.toContain(orgSecret.id);
      expect((await grantsOf(beta.id)).secrets).not.toContain(orgSecret.id);

      // ── 4. A new agent starts with the connection and the custom secret.
      const gamma = await createAgent(`${P}gamma`);
      const gammaGrants = await grantsOf(gamma.id);
      expect(gammaGrants.connections).toEqual([`${connectionId}:full`]);
      expect(gammaGrants.secrets).toContain(custom.id);
      expect(gammaGrants.secrets).not.toContain(orgSecret.id);
      expect((await injectableFor(gamma.id)).connections).toEqual([
        connectionId,
      ]);

      // ── 5. Narrow alpha; a re-connect of the same account changes nothing,
      //       and a detach sticks.
      const narrow = await call(
        "PUT",
        `/v1/agents/${alpha.id}/grants/connections/${connectionId}`,
        { access: "custom", allow: ["list_emails"], ask: [] },
      );
      expect(narrow.status).toBe(200);
      const reconnect = await call("POST", "/v1/apps/resend/connect", {
        fields: { apiKey: "re_wire_key_rotated" },
        label: "mail@aawire.test",
      });
      expect(reconnect.status).toBe(200);
      // A reconnect carries no `connection` (nothing was created).
      expect(reconnect.json).toEqual({ success: true });
      expect((await grantsOf(alpha.id)).connections).toEqual([
        `${connectionId}:custom`,
      ]);
      expect(
        (
          await call(
            "DELETE",
            `/v1/agents/${beta.id}/grants/connections/${connectionId}`,
          )
        ).status,
      ).toBe(204);
      expect((await grantsOf(beta.id)).connections).toEqual([]);

      // ── 6. Delete alpha (a CUSTOM stack: its "everything else: block"
      //       is the shape that, orphaned, blocked every other agent).
      const gammaBefore = await injectableFor(gamma.id);
      const del = await call("DELETE", `/v1/agents/${alpha.id}`);
      expect(del.status).toBe(204);
      const everyone = await db.policyRuleV2.count({
        where: {
          workspaceId: WORKSPACE,
          isDefault: false,
          identities: { none: {} },
        },
      });
      expect(everyone).toBe(0);
      expect(await injectableFor(gamma.id)).toEqual(gammaBefore);
      expect((await grantsOf(gamma.id)).connections).toEqual([
        `${connectionId}:full`,
      ]);

      // ── 7b. Planted control: the other workspace's agent saw nothing.
      const foreign = await db.policyRuleV2.count({
        where: { identities: { some: { agentId: FOREIGN_AGENT } } },
      });
      expect(foreign).toBe(0);

      // Every automatic grant is attributed to the acting user.
      const audit = await db.auditLog.findMany({
        where: { workspaceId: WORKSPACE, service: "grant", userId: OWNER },
        select: { metadata: true },
      });
      const autos = audit.map(
        (a) => (a.metadata as { auto?: string } | null)?.auto,
      );
      expect(autos).toContain("workspace-autoattach");
      expect(autos).toContain("llm-autoattach");
      expect(JSON.stringify(audit)).not.toMatch(/custom-wire-value|sk-/);
    });
  },
);
