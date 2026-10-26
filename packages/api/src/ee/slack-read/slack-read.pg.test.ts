import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SlackReadAgentView } from "./service";
import { proofDatabaseUrl } from "../../testing/pg-proof";

/**
 * "Connect your Slack" read-grant proofs: real DB, fake Slack, the REAL
 * tool door. Each property the security review cares about is a test:
 *
 *  - connect: the token is stored encrypted; a token for a DIFFERENT Slack
 *    workspace is refused (and revoked at Slack); a non-member is refused;
 *    a tampered state is refused before Slack is ever called; reconnecting
 *    as a different Slack person drops the old person's shares;
 *  - grants: only conversations in the caller's OWN list can be granted,
 *    with the label taken from Slack, never the client;
 *  - read: no grant = refused, Slack never called; `granter_only` reads in
 *    the granter's direct thread and schedule only - a teammate's thread
 *    and a shared channel thread (even the granter speaking) are refused
 *    identically, so the conversation is not confirmed to exist; `anyone`
 *    reads anywhere; the read uses the GRANTER's token; people's messages
 *    with files are kept, channel bookkeeping is not; a thread with more
 *    replies says it is partial;
 *  - lifecycle: disconnect revokes at Slack and deletes every grant; Slack
 *    reporting the token dead deletes it on the next read; a user-token
 *    revocation event deletes exactly that person's token; both re-render
 *    the agent so the read tool stops being listed;
 *  - tenancy: a foreign workspace cannot list, grant, or delete;
 *  - the reader is never present unlicensed (tool refuses).
 */

const PROOF_URL = proofDatabaseUrl();

const P = "srg-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OTHER_WORKSPACE = `${P}other-ws`;
const ALEX = `${P}alex`;
const JORDAN = `${P}jordan`;
const OUTSIDER = `${P}outsider`;
const ADMIN = `${P}admin`;
const TEAM = "T0SRG";

let db: typeof import("@onecli/db").db;
let svc: typeof import("./service");
let ee: typeof import("./index");
let platformTools: typeof import("../../services/platform-tool-service");
let readerHook: typeof import("../../providers/hooks/conversation-reader");
let oauthState: typeof import("../../lib/oauth-state");

interface SlackCall {
  method: string;
  form: URLSearchParams;
  auth: string | undefined;
}
let slackServer: Server;
let calls: SlackCall[] = [];
let handlers: Record<string, (call: SlackCall) => unknown> = {};
const callsFor = (m: string) => calls.filter((c) => c.method === m);

const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const call: SlackCall = {
          method: (req.url ?? "/").slice(1),
          form: new URLSearchParams(raw),
          auth: req.headers.authorization,
        };
        calls.push(call);
        const h = handlers[call.method];
        const body = h ? h(call) : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...(body as object) }));
      });
    });
    slackServer.listen(0, "127.0.0.1", () =>
      resolve(
        `http://127.0.0.1:${(slackServer.address() as AddressInfo).port}`,
      ),
    );
  });

const ALEX_TOKEN = "xoxp-alex";
const JORDAN_TOKEN = "xoxp-jordan";

const script = (opts: { deadToken?: boolean } = {}) => {
  calls = [];
  handlers = {
    "users.conversations": (c) =>
      c.auth === `Bearer ${ALEX_TOKEN}`
        ? {
            channels: [
              { id: "C0REPORTS", name: "weekly-reports", is_channel: true },
              { id: "D0SAM", is_im: true, user: "U0SAM" },
            ],
            response_metadata: { next_cursor: "" },
          }
        : {
            channels: [{ id: "C0GENERAL", name: "general", is_channel: true }],
            response_metadata: { next_cursor: "" },
          },
    "users.info": (c) => ({
      user: {
        id: c.form.get("user"),
        name: c.form.get("user") === "U0SAM" ? "sam" : "someone",
        profile: {
          display_name: c.form.get("user") === "U0SAM" ? "Sam" : "",
        },
      },
    }),
    "conversations.history": () =>
      opts.deadToken
        ? { ok: false, error: "token_revoked" }
        : {
            messages: [
              {
                ts: "1700000200.000200",
                user: "U0ALEX",
                text: "second <@U0ALEX>",
              },
              // A person's message with a file is still their message;
              // a join is channel bookkeeping and never reaches the model.
              {
                ts: "1700000160.000160",
                subtype: "file_share",
                user: "U0SAM",
                text: "notes attached",
              },
              { ts: "1700000150.000150", subtype: "channel_join", user: "U0X" },
              { ts: "1700000100.000100", user: "U0SAM", text: "first" },
            ],
            has_more: false,
          },
    "auth.revoke": () => ({ revoked: true }),
    "conversations.replies": () => ({ ok: false, error: "thread_not_found" }),
    // Per-token visibility, like Slack: Alex sees her channel and her
    // DM with Sam; Jordan sees only #general; anything else is refused.
    "conversations.info": (c) => {
      const id = c.form.get("channel");
      const seen: Record<string, Record<string, unknown>> = c.auth ===
      `Bearer ${ALEX_TOKEN}`
        ? {
            C0REPORTS: {
              id: "C0REPORTS",
              name: "weekly-reports",
              is_channel: true,
              is_member: true,
            },
            D0SAM: { id: "D0SAM", is_im: true, user: "U0SAM" },
          }
        : {
            C0GENERAL: {
              id: "C0GENERAL",
              name: "general",
              is_channel: true,
              is_member: true,
            },
          };
      const channel = id ? seen[id] : undefined;
      return channel ? { channel } : { ok: false, error: "channel_not_found" };
    },
  };
};

let seq = 0;

const seedAgent = async (suffix: string) => {
  seq += 1;
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `Helper ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  const integration =
    (await db.channelIntegration.findFirst({
      where: { organizationId: ORG, provider: "slack" },
      select: { id: true },
    })) ??
    (await db.channelIntegration.create({
      data: { organizationId: ORG, provider: "slack", externalId: TEAM },
      select: { id: true },
    }));
  const { getCrypto } = await import("../../providers");
  const row = await db.agentChannel.create({
    data: {
      agentId: agent.id,
      integrationId: integration.id,
      provider: "slack",
      externalId: `A0${P}${seq}`,
      identityRef: `U0BOT${seq}`,
      transport: "events",
      status: "active",
      credentials: await getCrypto().encrypt(
        JSON.stringify({
          botToken: "xoxb-bot",
          clientId: "cid",
          clientSecret: "csecret",
        }),
      ),
    },
    select: { id: true },
  });
  await db.channelUserLink.upsert({
    where: {
      integrationId_externalUserId: {
        integrationId: integration.id,
        externalUserId: "U0ALEX",
      },
    },
    create: {
      integrationId: integration.id,
      externalUserId: "U0ALEX",
      userId: ALEX,
      linkedVia: "manual",
    },
    update: {},
  });

  const RUNNER = `${P}runner-${suffix}`;
  const SANDBOX = `${P}sb-${suffix}`;
  await db.runner.create({
    data: { id: RUNNER, name: "runner", token: `rnr_${P}${suffix}` },
  });
  await db.sandbox.create({
    data: {
      id: SANDBOX,
      agentId: agent.id,
      runnerId: RUNNER,
      status: "running",
    },
  });

  const conversation = async (
    kind: "direct" | "channel" | "cron" | "cron-in-channel",
    userId: string,
  ) => {
    let id: string;
    if (kind === "direct") {
      // One direct thread per (agent, user), by a partial unique index.
      const existing = await db.conversation.findFirst({
        where: { agentId: agent.id, direct: true, userId },
        select: { id: true },
      });
      id =
        existing?.id ??
        (
          await db.conversation.create({
            data: { agentId: agent.id, direct: true, userId, source: "web" },
            select: { id: true },
          })
        ).id;
    } else if (kind === "channel") {
      id = (
        await db.conversation.create({
          data: {
            agentId: agent.id,
            source: "slack",
            externalRef: `${P}t-${Math.random()}`,
          },
          select: { id: true },
        })
      ).id;
    } else {
      // A schedule's report goes to its origin: "cron" = no origin (private),
      // "cron-in-channel" = created from a shared channel thread.
      const origin =
        kind === "cron-in-channel"
          ? (
              await db.conversation.create({
                data: {
                  agentId: agent.id,
                  source: "slack",
                  externalRef: `${P}origin-${Math.random()}`,
                },
                select: { id: true },
              })
            ).id
          : null;
      const cron = await db.agentCron.create({
        data: {
          agentId: agent.id,
          name: "morning summary",
          prompt: "summarize",
          schedule: "30 9 * * *",
          timezone: "UTC",
          nextFireAt: new Date(Date.now() + 86_400_000),
          createdByUserId: userId,
          originConversationId: origin,
        },
        select: { id: true },
      });
      id = (
        await db.conversation.create({
          data: { agentId: agent.id, source: "cron", externalRef: cron.id },
          select: { id: true },
        })
      ).id;
    }
    const turn = await db.turn.create({
      data: {
        conversationId: id,
        message: "read it",
        status: "done",
        finishedAt: new Date(),
        source: kind.startsWith("cron") ? "cron" : "web",
        userId: kind.startsWith("cron") ? null : userId,
      },
      select: { id: true },
    });
    return { conversationId: id, turnId: turn.id };
  };

  const read = async (
    where: "direct" | "channel" | "cron" | "cron-in-channel",
    asUser: string,
    args: unknown,
  ) => {
    const ctx = await conversation(where, asUser);
    return platformTools.executePlatformTool(RUNNER, {
      sandboxId: SANDBOX,
      tool: "read_conversation",
      args,
      ...ctx,
    });
  };

  /** Read from a turn in an EXISTING conversation; `speaker` null = a
   * platform turn (a schedule's own fire). */
  const readIn = async (
    conversationId: string,
    speaker: string | null,
    args: unknown,
  ) => {
    const turn = await db.turn.create({
      data: {
        conversationId,
        message: "read it",
        status: "done",
        finishedAt: new Date(),
        source: speaker === null ? "cron" : "web",
        userId: speaker,
      },
      select: { id: true },
    });
    return platformTools.executePlatformTool(RUNNER, {
      sandboxId: SANDBOX,
      tool: "read_conversation",
      args,
      conversationId,
      turnId: turn.id,
    });
  };

  return {
    agentId: agent.id,
    presenceId: row.id,
    read,
    readIn,
    conversation,
  };
};

/** Store a user token directly (the OAuth path has its own tests). */
const connectAs = async (
  presenceId: string,
  userId: string,
  slackUser: string,
  token: string,
) => {
  const { getCrypto } = await import("../../providers");
  return db.agentChannelUserToken.create({
    data: {
      agentChannelId: presenceId,
      userId,
      externalUserId: slackUser,
      credentials: await getCrypto().encrypt(
        JSON.stringify({ accessToken: token }),
      ),
    },
    select: { id: true },
  });
};

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = await startSlackFake();
  process.env.EDITION = "cloud";
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  process.env.OAUTH_STATE_SECRET = "srg-state-secret";

  ({ db } = await import("@onecli/db"));
  const { ensureEditionDefaults } = await import("../../edition-defaults");
  ensureEditionDefaults();
  svc = await import("./service");
  ee = await import("./index");
  platformTools = await import("../../services/platform-tool-service");
  readerHook = await import("../../providers/hooks/conversation-reader");
  oauthState = await import("../../lib/oauth-state");
  const quota = await import("../services/quota-service");
  // Plan gating is its own suite; here the org is on a granular-capable plan.
  vi.spyOn(quota, "assertCanUseGranularAccess").mockResolvedValue();

  await reset();
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.createMany({
    data: [
      { id: WORKSPACE, name: "SRG", organizationId: ORG },
      { id: OTHER_WORKSPACE, name: "SRG other", organizationId: ORG },
    ],
  });
  for (const [id, name] of [
    [ALEX, "Alex"],
    [JORDAN, "Jordan"],
    [OUTSIDER, "Outsider"],
    [ADMIN, "Admin"],
  ] as const) {
    await db.user.create({
      data: { id, email: `${id}@example.com`, externalAuthId: id, name },
    });
  }
  await db.organizationMember.createMany({
    data: [
      ...[ALEX, JORDAN].map((userId) => ({ userId, role: "member" })),
      { userId: ADMIN, role: "admin" },
    ].map(({ userId, role }) => ({
      organizationId: ORG,
      userId,
      userEmail: `${userId}@example.com`,
      role,
    })),
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  slackServer?.close();
});

const grantAs = (
  agentId: string,
  userId: string,
  ref: string,
  audience: "anyone" | "granter_only",
) =>
  svc.upsertGrant({
    workspaceId: WORKSPACE,
    agentId,
    userId,
    externalRef: ref,
    audience,
  });

describe.skipIf(!PROOF_URL)("connect your Slack: read grants", () => {
  it("the OAuth return stores an encrypted token for the right person and workspace", async () => {
    script();
    const stage = await seedAgent("connect");
    const state = oauthState.verifyOAuthState(
      oauthState.signOAuthState({
        provider: "slack",
        kind: "slack-user-read",
        nonce: "n",
        workspaceId: WORKSPACE,
        agentId: stage.agentId,
        presenceId: stage.presenceId,
        userId: ALEX,
        issuedAt: Date.now(),
      }),
    )!;
    await svc.completeConnect({
      state,
      code: "code",
      redirectUri: "https://x/cb",
      exchange: async () => ({
        team: { id: TEAM },
        authed_user: { id: "U0ALEX", access_token: ALEX_TOKEN },
      }),
      isActiveMember: async () => true,
    });
    const row = await db.agentChannelUserToken.findFirstOrThrow({
      where: { agentChannelId: stage.presenceId, userId: ALEX },
      select: { credentials: true, externalUserId: true },
    });
    expect(row.externalUserId).toBe("U0ALEX");
    expect(row.credentials).not.toContain(ALEX_TOKEN);
  });

  it("refuses a token from a different Slack workspace (and revokes it), a non-member, and an expired state", async () => {
    script();
    const stage = await seedAgent("connect-refusals");
    const sign = (over: Record<string, unknown> = {}) =>
      oauthState.verifyOAuthState(
        oauthState.signOAuthState({
          provider: "slack",
          kind: "slack-user-read",
          nonce: "n",
          workspaceId: WORKSPACE,
          agentId: stage.agentId,
          presenceId: stage.presenceId,
          userId: ALEX,
          issuedAt: Date.now(),
          ...over,
        }),
      )!;
    const exchange = (team: string) => async () => ({
      team: { id: team },
      authed_user: { id: "U0ALEX", access_token: ALEX_TOKEN },
    });

    await expect(
      svc.completeConnect({
        state: sign(),
        code: "c",
        redirectUri: "r",
        exchange: exchange("T0FOREIGN"),
        isActiveMember: async () => true,
      }),
    ).rejects.toThrow(/different Slack workspace/);
    expect(callsFor("auth.revoke")).toHaveLength(1);

    await expect(
      svc.completeConnect({
        state: sign(),
        code: "c",
        redirectUri: "r",
        exchange: exchange(TEAM),
        isActiveMember: async () => false,
      }),
    ).rejects.toThrow(/not valid/);

    await expect(
      svc.completeConnect({
        state: sign({ issuedAt: Date.now() - 60 * 60 * 1000 }),
        code: "c",
        redirectUri: "r",
        exchange: exchange(TEAM),
        isActiveMember: async () => true,
      }),
    ).rejects.toThrow(/expired/);

    // A state naming another workspace's agent never matches the presence.
    await expect(
      svc.completeConnect({
        state: sign({ workspaceId: OTHER_WORKSPACE }),
        code: "c",
        redirectUri: "r",
        exchange: exchange(TEAM),
        isActiveMember: async () => true,
      }),
    ).rejects.toThrow(/not valid/);

    expect(
      await db.agentChannelUserToken.count({
        where: { agentChannelId: stage.presenceId },
      }),
    ).toBe(0);
  });

  it("account-linking CSRF: the Slack person who approved must BE the OneCLI user who started the flow", async () => {
    script();
    const stage = await seedAgent("csrf");
    const sign = (userId: string) =>
      oauthState.verifyOAuthState(
        oauthState.signOAuthState({
          provider: "slack",
          kind: "slack-user-read",
          nonce: "n",
          workspaceId: WORKSPACE,
          agentId: stage.agentId,
          presenceId: stage.presenceId,
          userId,
          issuedAt: Date.now(),
        }),
      )!;
    // Jordan started the flow, but ALEX (linked as U0ALEX) approved it.
    await expect(
      svc.completeConnect({
        state: sign(JORDAN),
        code: "c",
        redirectUri: "r",
        exchange: async () => ({
          team: { id: TEAM },
          authed_user: { id: "U0ALEX", access_token: ALEX_TOKEN },
        }),
        isActiveMember: async () => true,
      }),
    ).rejects.toThrow(/doesn't match your OneCLI account/);
    // An unlinked Slack person whose profile email is someone else's.
    handlers["users.info"] = () => ({
      user: { id: "U0STRANGER", profile: { email: "stranger@example.com" } },
    });
    await expect(
      svc.completeConnect({
        state: sign(JORDAN),
        code: "c",
        redirectUri: "r",
        exchange: async () => ({
          team: { id: TEAM },
          authed_user: { id: "U0STRANGER", access_token: "xoxp-x" },
        }),
        isActiveMember: async () => true,
      }),
    ).rejects.toThrow(/doesn't match/);
    expect(callsFor("auth.revoke")).toHaveLength(2);
    // An unlinked Slack person whose email IS Jordan's: accepted.
    handlers["users.info"] = () => ({
      user: { id: "U0JORDAN", profile: { email: `${JORDAN}@example.com` } },
    });
    await svc.completeConnect({
      state: sign(JORDAN),
      code: "c",
      redirectUri: "r",
      exchange: async () => ({
        team: { id: TEAM },
        authed_user: { id: "U0JORDAN", access_token: JORDAN_TOKEN },
      }),
      isActiveMember: async () => true,
    });
    expect(
      await db.agentChannelUserToken.findMany({
        where: { agentChannelId: stage.presenceId },
        select: { userId: true, externalUserId: true },
      }),
    ).toEqual([{ userId: JORDAN, externalUserId: "U0JORDAN" }]);
  });

  it("a tampered state is refused before Slack is called", async () => {
    script();
    const stage = await seedAgent("tamper");
    const good = oauthState.signOAuthState({
      provider: "slack",
      kind: "slack-user-read",
      nonce: "n",
      workspaceId: WORKSPACE,
      agentId: stage.agentId,
      presenceId: stage.presenceId,
      userId: ALEX,
      issuedAt: Date.now(),
    });
    const decoded = JSON.parse(Buffer.from(good, "base64url").toString());
    decoded.data.userId = JORDAN;
    const forged = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    await expect(
      ee.eeUserReadConnectCompleter.complete({
        state: forged,
        code: "c",
        redirectUri: "r",
      }),
    ).rejects.toThrow(/not valid/);
    // Refused before any exchange: Slack saw nothing, nothing was stored.
    expect(calls).toHaveLength(0);
    expect(
      await db.agentChannelUserToken.count({
        where: { agentChannelId: stage.presenceId },
      }),
    ).toBe(0);
  });

  it("only your OWN conversations can be granted, labelled by Slack", async () => {
    script();
    const stage = await seedAgent("grant-own");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await connectAs(stage.presenceId, JORDAN, "U0JORDAN", JORDAN_TOKEN);

    const dm = await grantAs(stage.agentId, ALEX, "D0SAM", "granter_only");
    expect(dm.subjectLabel).toBe("@Sam");
    expect(dm.subjectKind).toBe("dm");
    // Jordan is not in Alex's DM with Sam: she cannot grant it.
    await expect(
      grantAs(stage.agentId, JORDAN, "D0SAM", "anyone"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Not connected at all.
    await expect(
      grantAs(stage.agentId, OUTSIDER, "C0REPORTS", "anyone"),
    ).rejects.toThrow(/Connect your Slack/);
  });

  it("bulk share: all-or-nothing on ownership, one independent grant per pick", async () => {
    script();
    const stage = await seedAgent("grant-bulk");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    const bulk = (userId: string, refs: string[]) =>
      svc.shareConversations({
        workspaceId: WORKSPACE,
        agentId: stage.agentId,
        userId,
        externalRefs: refs,
        audience: "granter_only",
      });
    // One foreign ref (Jordan's #general) refuses the WHOLE request.
    await expect(
      bulk(ALEX, ["C0REPORTS", "D0SAM", "C0GENERAL"]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await db.agentReadGrant.count({
        where: { userToken: { agentChannelId: stage.presenceId } },
      }),
    ).toBe(0);
    await expect(bulk(ALEX, [])).rejects.toMatchObject({
      code: "UNPROCESSABLE",
    });

    const grants = await bulk(ALEX, ["C0REPORTS", "D0SAM", "D0SAM"]);
    expect(grants.map((g) => [g.subjectLabel, g.subjectKind]).sort()).toEqual(
      [
        ["#weekly-reports", "channel"],
        ["@Sam", "dm"],
      ].sort(),
    );
    // Each is its own grant: removing one leaves the other readable.
    await svc.deleteGrant({
      workspaceId: WORKSPACE,
      agentId: stage.agentId,
      grantId: grants.find((g) => g.externalRef === "D0SAM")!.id,
    });
    const left = await svc.listGrants({
      workspaceId: WORKSPACE,
      agentId: stage.agentId,
      userId: ALEX,
    });
    expect(left.map((g) => g.externalRef)).toEqual(["C0REPORTS"]);
  });

  it("read: no grant = refused and Slack never called; a grant reads with the granter's token, oldest first", async () => {
    script();
    const stage = await seedAgent("read");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);

    const none = await stage.read("direct", ALEX, {
      conversation: "#weekly-reports",
    });
    expect(none.ok).toBe(false);
    expect(callsFor("conversations.history")).toHaveLength(0);

    await grantAs(stage.agentId, ALEX, "C0REPORTS", "granter_only");
    const res = await stage.read("direct", ALEX, {
      conversation: "#weekly-reports",
    });
    expect(res.ok).toBe(true);
    const msgs = (
      res as { result: { messages: { text: string; author: string }[] } }
    ).result.messages;
    expect(msgs.map((m) => m.text)).toEqual([
      "first",
      "notes attached",
      "second @[Alex]",
    ]);
    expect(msgs.map((m) => m.author)).toEqual(["Sam", "Sam", "Alex"]);
    expect(callsFor("conversations.history")[0]?.auth).toBe(
      `Bearer ${ALEX_TOKEN}`,
    );
  });

  it("forgiving calls: no name lists what YOU may read, a partial name reads, a bad thread falls back, no window = latest", async () => {
    script();
    const stage = await seedAgent("forgiving");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS", "granter_only");
    const texts = (r: unknown) =>
      (r as { result: { messages: { text: string }[] } }).result.messages.map(
        (m) => m.text,
      );

    const list = await stage.read("direct", ALEX, {});
    expect(list).toMatchObject({
      ok: true,
      result: { readable: ["#weekly-reports"] },
    });
    // The audience fence still applies to the list: a shared thread (no
    // verified reader) learns nothing about an Only-me share.
    expect(await stage.read("channel", ALEX, {})).toMatchObject({
      ok: true,
      result: { readable: [] },
    });

    const partial = await stage.read("direct", ALEX, {
      conversation: "weekly",
    });
    expect(texts(partial)).toEqual([
      "first",
      "notes attached",
      "second @[Alex]",
    ]);

    // A channel id where a message id belongs is dropped at the edge...
    const channelAsThread = await stage.read("direct", ALEX, {
      conversation: "#weekly-reports",
      thread: "C0REPORTS",
    });
    expect(texts(channelAsThread)).toHaveLength(3);
    // ...and a well-formed id that isn't a thread reads the conversation.
    const notAThread = await stage.read("direct", ALEX, {
      conversation: "#weekly-reports",
      thread: "1700000999.000001",
    });
    expect(texts(notAThread)).toEqual([
      "first",
      "notes attached",
      "second @[Alex]",
    ]);
    expect((notAThread as { result: { note: string } }).result.note).toMatch(
      /not a thread here/,
    );

    // No sinceHours: no `oldest` bound is sent, so old messages still come.
    calls = [];
    const full = await stage.read("direct", ALEX, {
      conversation: "#weekly-reports",
    });
    expect(callsFor("conversations.history")[0]?.form.get("oldest")).toBeNull();
    // Slack said has_more:false and no window was set: this IS the start.
    expect(full).toMatchObject({ result: { reachedStart: true } });
    expect(
      (full as { result: { nextBefore?: string } }).result.nextBefore,
    ).toBeUndefined();
    // Paging back sends the cursor as Slack's exclusive upper bound.
    calls = [];
    await stage.read("direct", ALEX, {
      conversation: "#weekly-reports",
      before: "1700000100.000100",
    });
    expect(callsFor("conversations.history")[0]?.form.get("latest")).toBe(
      "1700000100.000100",
    );
  });

  it("Only me: the granter's DM and schedule read; Jordan's DM and a shared channel thread are refused identically", async () => {
    script();
    const stage = await seedAgent("audience");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "D0SAM", "granter_only");

    expect(
      (await stage.read("direct", ALEX, { conversation: "@Sam" })).ok,
    ).toBe(true);
    expect((await stage.read("cron", ALEX, { conversation: "@Sam" })).ok).toBe(
      true,
    );

    const before = callsFor("conversations.history").length;
    const jordan = await stage.read("direct", JORDAN, {
      conversation: "@Sam",
    });
    const shared = await stage.read("channel", ALEX, {
      conversation: "@Sam",
    });
    for (const refused of [jordan, shared]) {
      expect(refused.ok).toBe(false);
      const err = String((refused as { error: string }).error);
      expect(err).toMatch(/don't have read access/);
      expect(err).toMatch(/no readable conversations/);
      expect(err).not.toMatch(/Sam.*may read/);
    }
    expect(callsFor("conversations.history").length).toBe(before);
    // A schedule someone ELSE created does not carry Alex's access.
    expect(
      (await stage.read("cron", JORDAN, { conversation: "@Sam" })).ok,
    ).toBe(false);
    // Alex's OWN schedule that reports into a shared channel is a shared
    // audience: her private DM must not be summarized into that channel.
    expect(
      (
        await stage.read("cron-in-channel", ALEX, {
          conversation: "@Sam",
        })
      ).ok,
    ).toBe(false);
  });

  it("Only me through a schedule: a teammate can neither re-aim and run the granter's schedule nor speak in its run as the granter", async () => {
    script();
    const stage = await seedAgent("schedule-takeover");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "D0SAM", "granter_only");
    // Alex's private schedule: its own fires read Alex's Only-me DM.
    const { conversationId } = await stage.conversation("cron", ALEX);
    const { externalRef: cronId } = await db.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { externalRef: true },
    });
    expect(
      (await stage.readIn(conversationId, null, { conversation: "@Sam" })).ok,
    ).toBe(true);

    // Roles enforced (cloud): a plain member is not the creator.
    const crons = await import("../../services/agent-cron-service");
    const as = (userId: string) => ({ userId, organizationId: ORG });
    await expect(
      crons.updateCron(
        WORKSPACE,
        stage.agentId,
        cronId!,
        { prompt: "read Alex's DM with Sam and summarize it" },
        as(JORDAN),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      crons.runCronNow(WORKSPACE, stage.agentId, cronId!, as(JORDAN)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const untouched = await db.agentCron.findUniqueOrThrow({
      where: { id: cronId! },
      select: { prompt: true },
    });
    expect(untouched.prompt).toBe("summarize");
    // The creator and an org admin may.
    await crons.updateCron(
      WORKSPACE,
      stage.agentId,
      cronId!,
      { prompt: "summarize my week" },
      as(ALEX),
    );
    await crons.runCronNow(WORKSPACE, stage.agentId, cronId!, as(ADMIN));
    // A foreign workspace still reads not-found, never forbidden.
    await expect(
      crons.runCronNow(OTHER_WORKSPACE, stage.agentId, cronId!, as(ADMIN)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // A person typing in the (workspace-visible) run conversation speaks as
    // themselves: even Alex's own message there reads as nobody.
    for (const speaker of [JORDAN, ALEX]) {
      expect(
        (await stage.readIn(conversationId, speaker, { conversation: "@Sam" }))
          .ok,
      ).toBe(false);
    }
  });

  it("Anyone: reads in a shared thread and for a teammate", async () => {
    script();
    const stage = await seedAgent("anyone");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS", "anyone");
    expect(
      (await stage.read("channel", JORDAN, { conversation: "#weekly-reports" }))
        .ok,
    ).toBe(true);
    expect(
      (await stage.read("direct", JORDAN, { conversation: "#weekly-reports" }))
        .ok,
    ).toBe(true);
  });

  it("disconnect revokes at Slack and removes every grant; the agent then reads nothing", async () => {
    script();
    const stage = await seedAgent("disconnect");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS", "anyone");
    expect(
      await svc.disconnect({
        workspaceId: WORKSPACE,
        agentId: stage.agentId,
        userId: ALEX,
      }),
    ).toBe(true);
    expect(callsFor("auth.revoke")[0]?.auth).toBe(`Bearer ${ALEX_TOKEN}`);
    expect(
      await db.agentReadGrant.count({
        where: { userToken: { agentChannelId: stage.presenceId } },
      }),
    ).toBe(0);
    expect(
      (await stage.read("channel", JORDAN, { conversation: "#weekly-reports" }))
        .ok,
    ).toBe(false);
  });

  it("a token Slack reports dead is deleted on the next read; a revocation event deletes exactly that person; each re-renders the agent", async () => {
    const stage = await seedAgent("revoked");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await connectAs(stage.presenceId, JORDAN, "U0JORDAN", JORDAN_TOKEN);
    script();
    await grantAs(stage.agentId, ALEX, "C0REPORTS", "anyone");
    // The read tool is listed only while shares exist, so losing them must
    // re-render the agent (its home generation moves) or the tool lingers.
    const generation = async () =>
      (
        await db.sandbox.findFirstOrThrow({
          where: { agentId: stage.agentId },
          select: { homeDesiredGeneration: true },
        })
      ).homeDesiredGeneration;
    // The bump is fire-and-forget: wait for it rather than racing it.
    const bumpedPast = (seen: number) =>
      vi.waitFor(async () => expect(await generation()).toBeGreaterThan(seen));

    script({ deadToken: true });
    const beforeDead = await generation();
    const res = await stage.read("direct", ALEX, {
      conversation: "#weekly-reports",
    });
    expect(res.ok).toBe(false);
    expect(String((res as { error: string }).error)).toMatch(
      /connection is gone/,
    );
    expect(
      await db.agentChannelUserToken.count({
        where: { userId: ALEX, agentChannelId: stage.presenceId },
      }),
    ).toBe(0);
    await bumpedPast(beforeDead);

    const { dispatchSlackEvent } =
      await import("../../services/channels/providers/slack/dispatch");
    const beforeRevoke = await generation();
    await dispatchSlackEvent({
      presenceId: stage.presenceId,
      identityRef: "U0BOT",
      eventId: `${P}ev`,
      event: { type: "tokens_revoked", tokens: { oauth: ["U0JORDAN"] } },
    });
    expect(
      await db.agentChannelUserToken.count({
        where: { agentChannelId: stage.presenceId },
      }),
    ).toBe(0);
    await bumpedPast(beforeRevoke);
    expect(
      await db.agentChannel.count({
        where: { id: stage.presenceId, status: "active" },
      }),
    ).toBe(1);
  });

  it("a thread read that comes back with more replies says it is partial, never complete", async () => {
    script();
    const stage = await seedAgent("thread-partial");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS", "anyone");
    handlers["conversations.replies"] = () => ({
      messages: [
        { ts: "1700000100.000100", user: "U0SAM", text: "parent" },
        { ts: "1700000110.000110", user: "U0ALEX", text: "reply" },
      ],
      has_more: true,
    });
    const res = await stage.read("direct", ALEX, {
      conversation: "#weekly-reports",
      thread: "1700000100.000100",
    });
    const { result } = res as {
      result: { messages: { text: string }[]; note: string };
    };
    // Threads read oldest first, parent on top.
    expect(result.messages.map((m) => m.text)).toEqual(["parent", "reply"]);
    expect(result.note).toMatch(/^Partial: .*the thread has more/);
  });

  it("reconnecting as a different Slack person replaces the token and drops the old person's shares", async () => {
    script();
    const stage = await seedAgent("reconnect");
    await connectAs(stage.presenceId, ALEX, "U0OLD", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS", "granter_only");
    await svc.completeConnect({
      state: oauthState.verifyOAuthState(
        oauthState.signOAuthState({
          provider: "slack",
          kind: "slack-user-read",
          nonce: "n",
          workspaceId: WORKSPACE,
          agentId: stage.agentId,
          presenceId: stage.presenceId,
          userId: ALEX,
          issuedAt: Date.now(),
        }),
      )!,
      code: "c",
      redirectUri: "r",
      exchange: async () => ({
        team: { id: TEAM },
        authed_user: { id: "U0ALEX", access_token: ALEX_TOKEN },
      }),
      isActiveMember: async () => true,
    });
    expect(
      await db.agentChannelUserToken.findMany({
        where: { agentChannelId: stage.presenceId },
        select: { userId: true, externalUserId: true },
      }),
    ).toEqual([{ userId: ALEX, externalUserId: "U0ALEX" }]);
    expect(
      await db.agentReadGrant.count({
        where: { userToken: { agentChannelId: stage.presenceId } },
      }),
    ).toBe(0);
  });

  it("finder: lists the workspace's Slack agents with only the CALLER's own standing, workspace-fenced", async () => {
    script();
    const a = await seedAgent("finder-a");
    const b = await seedAgent("finder-b");
    await connectAs(a.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await connectAs(b.presenceId, JORDAN, "U0JORDAN", JORDAN_TOKEN);
    await grantAs(a.agentId, ALEX, "C0REPORTS", "granter_only");
    await grantAs(a.agentId, ALEX, "D0SAM", "granter_only");
    await grantAs(b.agentId, JORDAN, "C0GENERAL", "anyone");

    const list = (workspaceId: string, userId: string) =>
      svc.listSlackReadAgents({ workspaceId, organizationId: ORG, userId });
    const pick = (rows: SlackReadAgentView[], id: string) =>
      rows.find((r) => r.agentId === id);

    const alex = await list(WORKSPACE, ALEX);
    expect(pick(alex, a.agentId)).toMatchObject({
      connected: true,
      sharedByMe: 2,
      available: true,
    });
    // Jordan's connection and share on agent B are NOT Alex's standing.
    expect(pick(alex, b.agentId)).toMatchObject({
      connected: false,
      sharedByMe: 0,
    });
    const jordan = await list(WORKSPACE, JORDAN);
    expect(pick(jordan, a.agentId)).toMatchObject({
      connected: false,
      sharedByMe: 0,
    });
    expect(pick(jordan, b.agentId)).toMatchObject({
      connected: true,
      sharedByMe: 1,
    });
    // Another workspace sees none of these agents.
    const foreign = await list(OTHER_WORKSPACE, ALEX);
    expect(pick(foreign, a.agentId)).toBeUndefined();
    expect(pick(foreign, b.agentId)).toBeUndefined();
  });

  it("tenancy: a foreign workspace cannot list, grant, delete, or see the connection", async () => {
    script();
    const stage = await seedAgent("tenancy");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    const g = await grantAs(stage.agentId, ALEX, "C0REPORTS", "anyone");
    const foreign = { workspaceId: OTHER_WORKSPACE, agentId: stage.agentId };
    await expect(
      svc.listGrants({ ...foreign, userId: ALEX }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      svc.getMyConnection({ ...foreign, userId: ALEX }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      svc.upsertGrant({
        ...foreign,
        userId: ALEX,
        externalRef: "C0REPORTS",
        audience: "anyone",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      svc.deleteGrant({ ...foreign, grantId: g.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.agentReadGrant.count({ where: { id: g.id } })).toBe(1);
  });

  it("unlicensed: with no reader the tool refuses with the license message, and Slack is never called", async () => {
    script();
    const stage = await seedAgent("unlicensed");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS", "anyone");
    const spy = vi
      .spyOn(readerHook, "getConversationReader")
      .mockReturnValue(null);
    try {
      const before = callsFor("conversations.history").length;
      const res = await stage.read("direct", ALEX, {
        conversation: "#weekly-reports",
      });
      expect(res.ok).toBe(false);
      expect(String((res as { error: string }).error)).toMatch(/licen[cs]e/i);
      expect(callsFor("conversations.history").length).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });
});
