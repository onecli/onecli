/**
 * Acceptance walk for the agent chat's surfaces, over the REAL public
 * interfaces only: the `/v1` routes the dashboard calls, through
 * `createApiApp` with a signed-in session, on real PostgreSQL.
 *
 *  1. First sign-in (GET /v1/auth/session) names the new organization after
 *     the email's company under the Public Suffix List, and a shared mailbox
 *     after the person, never after their display name.
 *  2. Connecting an app from an agent (POST /v1/apps/:p/connect with
 *     `agentId`) leaves a notice in the connecting person's own chat with
 *     that agent (GET /v1/conversations/:id/events), once.
 *  3. The bell's listing (GET /v1/workspaces/:id/channel-approvals) hands a
 *     scheduled run's and a webhook's hold the chat they report to, and never
 *     re-points a hold into another agent's chat through a forged run
 *     conversation (POST /v1/conversations with a foreign schedule's ref).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;

const P = "chatwire-";
const SELF_URL = "https://api.chatwire.test";

let currentSession: { id: string; email: string; name?: string } | null = null;

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; workspaceId?: string } = {},
) => {
  const res = await app.request(path, {
    method,
    headers: {
      ...(options.workspaceId && { "x-workspace-id": options.workspaceId }),
      ...(options.body !== undefined && { "content-type": "application/json" }),
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text ? (JSON.parse(text) as unknown) : null,
  };
};

/** Sign a brand-new person in through the session door; returns their
 * workspace and the org it was born into. */
const firstSignIn = async (label: string, email: string, name: string) => {
  currentSession = { id: `${P}ext-${label}`, email, name };
  const res = await call("GET", "/v1/auth/session");
  expect(res.status).toBe(200);
  const workspaceId = (res.json as { workspaceId: string }).workspaceId;
  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { organization: { select: { id: true, name: true } } },
  });
  return { workspaceId, org: workspace.organization };
};

const emails = (label: string) => `${P}${label}`;

const cleanup = async () => {
  const users = await db.user.findMany({
    where: { externalAuthId: { startsWith: P } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  const orgs = await db.organizationMember.findMany({
    where: { userId: { in: userIds } },
    select: { organizationId: true },
  });
  const orgIds = [...new Set(orgs.map((o) => o.organizationId))];
  const workspaces = await db.workspace.findMany({
    where: { organizationId: { in: orgIds } },
    select: { id: true },
  });
  const workspaceIds = workspaces.map((w) => w.id);
  const scoped = {
    OR: [
      { workspaceId: { in: workspaceIds } },
      { organizationId: { in: orgIds } },
    ],
  };
  await db.policyRuleV2.deleteMany({ where: scoped });
  await db.auditLog.deleteMany({
    where: {
      OR: [{ workspaceId: { in: workspaceIds } }, { userId: { in: userIds } }],
    },
  });
  await db.appConnection.deleteMany({ where: scoped });
  await db.secret.deleteMany({ where: scoped });
  await db.agent.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await db.apiKey.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await db.workspaceAccess.deleteMany({
    where: { workspaceId: { in: workspaceIds } },
  });
  await db.organizationMember.deleteMany({
    where: { organizationId: { in: orgIds } },
  });
  await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
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
});

afterAll(async () => {
  if (!PROOF_URL) return;
  vi.unstubAllGlobals();
  await cleanup();
});

describe.skipIf(!PROOF_URL)(
  "the agent chat's surfaces over the real /v1 routes, as the dashboard sees them",
  () => {
    it("first sign-in names the org after the company, or the person on a shared mailbox", async () => {
      for (const [label, email, expected] of [
        ["company", `dana@eu.${emails("acme")}.co.uk`, emails("acme")],
        ["psl", `dana@${emails("acme-jp")}.ne.jp`, emails("acme-jp")],
        ["gmail", `${emails("dana.cohen")}@gmail.com`, emails("dana.cohen")],
        ["regional", `${emails("dana")}@hotmail.co.uk`, emails("dana")],
      ] as const) {
        const { org } = await firstSignIn(label, email, "Dana Cohen");
        // Never the display name, never the provider, never the full email.
        expect(org.name).toBe(expected);
      }
    });

    it("an agent connect tells the person's own chat once, and the listing maps run holds only within the agent", async () => {
      const { workspaceId } = await firstSignIn(
        "owner",
        `${emails("owner")}@example.com`,
        "Olive Owner",
      );
      const inWs = { workspaceId };

      // Chats exist for hosted agents only; spawning one through the API
      // needs a runner, so the rows are seeded the way the hosted pg suites
      // do. Everything under test below goes through the routes.
      const hostedAgent = (suffix: string) =>
        db.agent.create({
          data: {
            workspaceId,
            name: `${P}${suffix}`,
            identifier: `${P}${suffix}`,
            accessToken: `aoc_${P}${suffix}`,
            kind: "hosted",
            harness: "fake",
          },
          select: { id: true },
        });
      const agent = await hostedAgent("agent");
      const other = await hostedAgent("other");

      // The person's own chat with the agent, with one finished exchange.
      const opened = await call(
        "PUT",
        `/v1/agents/${agent.id}/conversations/direct`,
        inWs,
      );
      expect(opened.status).toBe(200);
      const chat = opened.json as { id: string };
      await db.turn.create({
        data: {
          conversationId: chat.id,
          userId: (
            await db.user.findFirstOrThrow({
              where: { externalAuthId: `${P}ext-owner` },
              select: { id: true },
            })
          ).id,
          message: "read my mail",
          status: "done",
        },
      });

      // ── 2. Connect from the agent: a notice lands in that chat, once.
      const connect = () =>
        call("POST", "/v1/apps/resend/connect", {
          ...inWs,
          body: {
            fields: { apiKey: "re_wire_key" },
            label: "mail@chatwire.test",
            agentId: agent.id,
          },
        });
      expect((await connect()).status).toBe(200);
      const noticesIn = async () =>
        (
          (await call("GET", `/v1/conversations/${chat.id}/events`, inWs))
            .json as { events: { type: string; payload: { text?: string } }[] }
        ).events.filter((e) => e.type === "notice");
      const afterFirst = await noticesIn();
      expect(afterFirst.map((e) => e.payload.text)).toContain(
        "Resend (mail@chatwire.test) is now connected. You can ask the agent to use it.",
      );
      // Re-adding the same account changes no grant, so it says nothing.
      expect((await connect()).status).toBe(200);
      expect(await noticesIn()).toHaveLength(afterFirst.length);

      // ── 3. A scheduled run's and a webhook's holds show in the chat.
      const dayAhead = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const cron = await db.agentCron.create({
        data: {
          agentId: agent.id,
          name: "morning digest",
          prompt: "p",
          schedule: "0 9 * * *",
          timezone: "UTC",
          originConversationId: chat.id,
          nextFireAt: dayAhead,
        },
        select: { id: true },
      });
      const webhook = await db.agentWebhook.create({
        data: {
          agentId: agent.id,
          name: "deploys",
          instructions: "i",
          token: `whk_${P}token`,
          originConversationId: chat.id,
        },
        select: { id: true },
      });
      // Run conversations, minted through the public door like any client
      // could.
      const runOf = async (agentId: string, source: string, ref: string) =>
        (
          (
            await call("POST", "/v1/conversations", {
              ...inWs,
              body: { agentId, source, externalRef: ref },
            })
          ).json as { id: string }
        ).id;
      const cronRun = await runOf(agent.id, "cron", cron.id);
      const webhookRun = await runOf(agent.id, "webhook", webhook.id);
      // The forgery: ANOTHER agent's conversation claiming the schedule.
      const forged = await runOf(other.id, "cron", cron.id);
      for (const [agentId, summary, conversationId] of [
        [agent.id, "from the schedule", cronRun],
        [agent.id, "from the webhook", webhookRun],
        [other.id, "forged", forged],
      ] as const) {
        await db.actionApproval.create({
          data: {
            agentId,
            conversationId,
            action: "test.chatwire",
            payload: {},
            summary,
            status: "pending",
            expiresAt: dayAhead,
            cardRefs: [],
          },
        });
      }
      const bell = await call(
        "GET",
        `/v1/workspaces/${workspaceId}/channel-approvals`,
        inWs,
      );
      expect(bell.status).toBe(200);
      const where = Object.fromEntries(
        (
          bell.json as {
            items: {
              kind: string;
              summary?: string;
              conversationId?: string;
            }[];
          }
        ).items
          .filter((i) => i.kind === "action")
          .map((i) => [i.summary, i.conversationId]),
      );
      expect(where).toEqual({
        "from the schedule": chat.id,
        "from the webhook": chat.id,
        forged,
      });

      await db.agentCron.deleteMany({ where: { agentId: agent.id } });
      await db.agentWebhook.deleteMany({ where: { agentId: agent.id } });
    });
  },
);
