/**
 * Acceptance walk for who a new credential is on for, over the REAL public
 * interfaces: the `/v1` routes the dashboard, the CLI and the SDK call,
 * through `createApiApp` with a signed-in workspace owner, on real
 * PostgreSQL. It plays the story a user lives through:
 *
 *  1. Two agents exist; the user connects an app from the WORKSPACE
 *     (POST /v1/apps/:p/connect, no agent). It is on for neither agent, and
 *     the credential reflection (built on the PUBLISHED rule set, the one the
 *     gateway enforces) lists it as injectable for neither.
 *  2. A custom secret (POST /v1/secrets) is on for no agent either, and the
 *     "choose agents" view (GET /v1/secrets/:id/agents) lists both, off.
 *  3. One agent runs on OpenAI on purpose. A new Anthropic key goes only to
 *     the agent with no key; the OpenAI agent keeps exactly its one key.
 *  4. Connecting from an AGENT (`agentId` in the body) turns the new account
 *     on for that agent alone. Re-adding the same account from the other
 *     agent turns it on for that one too, and a narrowed grant survives a
 *     re-add.
 *  5. A foreign agent id is refused (404) and leaves no connection behind.
 *  6. A new agent (POST /v1/agents) starts with nothing but the LLM key.
 *  7. Planted controls: an org-scoped secret (POST /v1/org/secrets) and an
 *     agent of ANOTHER workspace are never touched.
 *
 * The service-level laws (add-only, one publish, fencing, deadlock, the
 * migration) are proven row by row in `agent-connect-grant-service.pg.test`;
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
// A different ORGANIZATION entirely, with its own workspace and agent: the
// cross-tenant planted control, beyond the sibling-workspace one.
const FOREIGN_ORG = `${P}foreign-org`;
const FOREIGN_ORG_WORKSPACE = `${P}foreign-org-ws`;
const FOREIGN_ORG_AGENT = `${P}foreign-org-agent`;
const SELF_URL = "https://api.aawire.test";

let currentSession: { id: string; email: string } | null = null;
const inWorkspace = { "x-workspace-id": WORKSPACE };

const call = async (
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) => {
  const res = await app.request(path, {
    method,
    headers: {
      ...inWorkspace,
      ...extraHeaders,
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
  const workspaces = [WORKSPACE, OTHER_WORKSPACE, FOREIGN_ORG_WORKSPACE];
  const scoped = {
    OR: [
      { workspaceId: { in: workspaces } },
      { organizationId: { in: [ORG, FOREIGN_ORG] } },
    ],
  };
  await db.policyRuleV2.deleteMany({ where: scoped });
  // By user too: the org-secret write audits at org scope, with no workspace.
  await db.auditLog.deleteMany({
    where: {
      OR: [{ workspaceId: { in: workspaces } }, { userId: OWNER }],
    },
  });
  await db.appConnection.deleteMany({ where: scoped });
  await db.secret.deleteMany({ where: scoped });
  await db.agent.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await db.workspaceAccess.deleteMany({
    where: { workspaceId: { in: workspaces } },
  });
  await db.organizationMember.deleteMany({
    where: { organizationId: { in: [ORG, FOREIGN_ORG] } },
  });
  await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
  await db.organization.deleteMany({
    where: { id: { in: [ORG, FOREIGN_ORG] } },
  });
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
  await db.organization.create({
    data: { id: FOREIGN_ORG, name: FOREIGN_ORG, slug: FOREIGN_ORG },
  });
  await db.workspace.create({
    data: {
      id: FOREIGN_ORG_WORKSPACE,
      name: FOREIGN_ORG_WORKSPACE,
      organizationId: FOREIGN_ORG,
    },
  });
  await db.agent.create({
    data: {
      id: FOREIGN_ORG_AGENT,
      identifier: FOREIGN_ORG_AGENT,
      name: "Other Org",
      workspaceId: FOREIGN_ORG_WORKSPACE,
      accessToken: `aoc_${FOREIGN_ORG_AGENT}`,
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
  "who a new credential is on for, as the API's callers see them",
  () => {
    it("on for nobody from the workspace, for the connecting agent alone from an agent", async () => {
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

      // ── 1. Connect an app from the workspace: on for nobody.
      const connect = await call("POST", "/v1/apps/resend/connect", {
        fields: { apiKey: "re_wire_key" },
        label: "mail@aawire.test",
      });
      expect(connect.status).toBe(200);
      const connectionId = (connect.json as { connection: { id: string } })
        .connection.id;
      for (const agent of [alpha, beta]) {
        expect((await grantsOf(agent.id)).connections).toEqual([]);
        expect((await injectableFor(agent.id)).connections).toEqual([]);
      }

      // ── 2. A custom secret is on for nobody; its view lists both, off.
      const custom = await createSecret("/v1/secrets", {
        name: "Custom API",
        type: "generic",
        value: "custom-wire-value",
        hostPattern: "api.example.com",
        injectionConfig: { headerName: "x-api-key" },
      });
      expect(custom.attachedAgents).toEqual([]);
      expect((await injectableFor(alpha.id)).secrets).not.toContain(custom.id);
      const access = await call("GET", `/v1/secrets/${custom.id}/agents`);
      expect(access.status).toBe(200);
      expect(
        (
          access.json as { agents: { agentId: string; granted: boolean }[] }
        ).agents
          .map((a) => `${a.agentId}:${a.granted}`)
          .sort(),
      ).toEqual([`${alpha.id}:false`, `${beta.id}:false`].sort());

      // ── 3. A new Anthropic key: only the keyless agent gets it.
      const anthropic = await createSecret("/v1/secrets", {
        name: "Anthropic",
        type: "anthropic",
        value: "sk-ant-wire",
        hostPattern: "api.anthropic.com",
      });
      expect(anthropic.attachedAgents).toEqual([beta.id]);
      expect((await grantsOf(alpha.id)).secrets).toEqual([openai.id]);
      expect((await grantsOf(beta.id)).secrets).toEqual([anthropic.id]);

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

      // ── 4. Connect from alpha: on for alpha alone.
      const fromAlpha = await call("POST", "/v1/apps/resend/connect", {
        fields: { apiKey: "re_alpha_key" },
        label: "alpha@aawire.test",
        agentId: alpha.id,
      });
      expect(fromAlpha.status).toBe(200);
      const alphaConnection = (fromAlpha.json as { connection: { id: string } })
        .connection.id;
      expect((await grantsOf(alpha.id)).connections).toEqual([
        `${alphaConnection}:custom`,
      ]);
      expect((await injectableFor(alpha.id)).connections).toEqual([
        alphaConnection,
      ]);
      expect((await grantsOf(beta.id)).connections).toEqual([]);

      // Alpha narrows it to full access; beta re-adds the same account from
      // its own page: beta gets it, alpha's choice survives.
      expect(
        (
          await call(
            "PUT",
            `/v1/agents/${alpha.id}/grants/connections/${alphaConnection}`,
            { access: "full" },
          )
        ).status,
      ).toBe(200);
      const fromBeta = await call("POST", "/v1/apps/resend/connect", {
        fields: { apiKey: "re_alpha_key_rotated" },
        label: "alpha@aawire.test",
        agentId: beta.id,
      });
      expect(fromBeta.status).toBe(200);
      // A re-add carries no `connection` (nothing was created).
      expect(fromBeta.json).toEqual({ success: true });
      expect((await grantsOf(alpha.id)).connections).toEqual([
        `${alphaConnection}:full`,
      ]);
      expect((await grantsOf(beta.id)).connections).toEqual([
        `${alphaConnection}:custom`,
      ]);

      // A Reconnect of one connection by id grants nobody new.
      const gamma = await createAgent(`${P}gamma`);
      const byId = await call("POST", "/v1/apps/resend/connect", {
        fields: { apiKey: "re_alpha_key_rotated_again" },
        connectionId: alphaConnection,
        agentId: gamma.id,
      });
      expect(byId.status).toBe(200);
      expect((await grantsOf(gamma.id)).connections).toEqual([]);

      // ── 5. A foreign agent id is refused and leaves nothing behind.
      const before = await db.appConnection.count({
        where: { workspaceId: WORKSPACE },
      });
      const foreign = await call("POST", "/v1/apps/resend/connect", {
        fields: { apiKey: "re_foreign_key" },
        label: "foreign@aawire.test",
        agentId: FOREIGN_AGENT,
      });
      expect(foreign.status).toBe(404);
      // …and so is an agent of another ORGANIZATION.
      const otherOrg = await call("POST", "/v1/apps/resend/connect", {
        fields: { apiKey: "re_other_org_key" },
        label: "other-org@aawire.test",
        agentId: FOREIGN_ORG_AGENT,
      });
      expect(otherOrg.status).toBe(404);
      expect(
        await db.appConnection.count({ where: { workspaceId: WORKSPACE } }),
      ).toBe(before);
      // An org-level connect has no agent to turn on: a 400, nothing stored.
      const orgBefore = await db.appConnection.count({
        where: { organizationId: ORG, scope: "organization" },
      });
      const orgConnect = await call(
        "POST",
        "/v1/apps/resend/connect",
        {
          fields: { apiKey: "re_org_key" },
          label: "org@aawire.test",
          agentId: (await createAgent(`${P}org-door`)).id,
        },
        { "x-organization-id": ORG },
      );
      expect(orgConnect.status).toBe(400);
      // Refused for the agent, not for the org-connect plumbing: the
      // connecting-agent rule answers before the org interceptor runs.
      expect(JSON.stringify(orgConnect.json)).toContain(
        "An organization connection has no agent to turn on.",
      );
      expect(
        await db.appConnection.count({
          where: { organizationId: ORG, scope: "organization" },
        }),
      ).toBe(orgBefore);

      // ── 6. A new agent starts with nothing but the LLM key.
      const gammaGrants = await grantsOf(gamma.id);
      expect(gammaGrants.connections).toEqual([]);
      expect(gammaGrants.secrets).not.toContain(custom.id);
      expect(gammaGrants.secrets).not.toContain(orgSecret.id);
      expect((await injectableFor(gamma.id)).connections).toEqual([]);

      // ── 7b. Planted control: the other workspace's agent saw nothing.
      expect(
        await db.policyRuleV2.count({
          where: {
            identities: {
              some: { agentId: { in: [FOREIGN_AGENT, FOREIGN_ORG_AGENT] } },
            },
          },
        }),
      ).toBe(0);
      // The workspace connect from step 1 is still on for nobody.
      for (const agent of [alpha, beta, gamma]) {
        expect((await grantsOf(agent.id)).connections).not.toContain(
          `${connectionId}:custom`,
        );
      }

      // Every automatic grant is attributed to the acting user.
      const audit = await db.auditLog.findMany({
        where: { workspaceId: WORKSPACE, service: "grant", userId: OWNER },
        select: { metadata: true },
      });
      const autos = audit.map(
        (a) => (a.metadata as { auto?: string } | null)?.auto,
      );
      expect(autos).toContain("agent-connect");
      expect(autos).toContain("llm-autoattach");
      expect(JSON.stringify(audit)).not.toMatch(/custom-wire-value|sk-/);
    });

    it("a reconnect keeps every agent's permissions exactly as they were", async () => {
      const keeper = await createAgent(`${P}keeper`);
      const connect = await call("POST", "/v1/apps/resend/connect", {
        fields: { apiKey: "re_keep_key" },
        label: "keep@aawire.test",
        agentId: keeper.id,
      });
      expect(connect.status).toBe(200);
      const connectionId = (connect.json as { connection: { id: string } })
        .connection.id;

      // The user narrows it: reads allowed, sending needs approval, other
      // writes blocked.
      const narrowed = await call(
        "PUT",
        `/v1/agents/${keeper.id}/grants/connections/${connectionId}`,
        {
          access: "custom",
          allow: ["get_email", "list_emails"],
          ask: ["send_email"],
          otherWrites: "never",
        },
      );
      expect(narrowed.status).toBe(200);

      const permissionsOf = async () => {
        const res = await call("GET", `/v1/agents/${keeper.id}/grants`);
        expect(res.status).toBe(200);
        const grant = (
          res.json as {
            connections: (Record<string, unknown> & { connectionId: string })[];
          }
        ).connections.find((c) => c.connectionId === connectionId);
        expect(grant).toBeDefined();
        return grant;
      };
      const before = await permissionsOf();
      expect(before).toMatchObject({
        access: "custom",
        ask: ["send_email"],
      });

      // Reconnect by id (the ⋮ menu / card Reconnect)…
      const byId = await call("POST", "/v1/apps/resend/connect", {
        fields: { apiKey: "re_keep_key_rotated" },
        connectionId,
      });
      expect(byId.status).toBe(200);
      expect(await permissionsOf()).toEqual(before);

      // …and by re-adding the same account name, from the same agent.
      const byName = await call("POST", "/v1/apps/resend/connect", {
        fields: { apiKey: "re_keep_key_rotated_again" },
        label: "keep@aawire.test",
        agentId: keeper.id,
      });
      expect(byName.status).toBe(200);
      expect(await permissionsOf()).toEqual(before);
    });
  },
);
