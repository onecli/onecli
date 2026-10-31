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
 *  - read: no grant = refused, Slack never called; a grant reads ONLY in
 *    the granter's direct thread and schedule - a teammate's own thread
 *    and a shared channel thread (even the granter speaking) are refused
 *    identically, so the conversation is not confirmed to exist; the read uses the GRANTER's token; people's messages
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
/** A fresh message ts per post, like Slack: the sent-as record is unique
 * on (channel, ts), and tests share #weekly-reports. Random base, so rows a
 * crashed earlier run left behind never collide either. */
let fakeTs = Math.floor(Math.random() * 1_000_000);
const nextTs = () => `${1700000000 + ++fakeTs}.000100`;

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
    suffix,
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
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
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
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  slackServer?.close();
});

const grantAs = (agentId: string, userId: string, ref: string) =>
  svc.upsertGrant({
    workspaceId: WORKSPACE,
    agentId,
    userId,
    externalRef: ref,
    readMode: "allow",
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

    const dm = await grantAs(stage.agentId, ALEX, "D0SAM");
    expect(dm.subjectLabel).toBe("@Sam");
    expect(dm.subjectKind).toBe("dm");
    // The DM's other person, so Contacts can show it under Sam's row.
    expect(dm.counterpartRef).toBe("U0SAM");
    // Jordan is not in Alex's DM with Sam: she cannot grant it.
    await expect(grantAs(stage.agentId, JORDAN, "D0SAM")).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
      },
    );
    // Not connected at all.
    await expect(grantAs(stage.agentId, OUTSIDER, "C0REPORTS")).rejects.toThrow(
      /Connect your Slack/,
    );
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
    expect(
      grants
        .map((g) => [g.subjectLabel, g.subjectKind, g.counterpartRef])
        .sort(),
    ).toEqual(
      [
        ["#weekly-reports", "channel", null],
        ["@Sam", "dm", "U0SAM"],
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

    // Not shared yet: the granter-to-be gets an access card, not a read.
    const none = await stage.read("direct", ALEX, {
      conversation: "#weekly-reports",
    });
    expect(none).toMatchObject({
      ok: true,
      result: { status: "needs_access", reason: "not_shared" },
    });
    expect(callsFor("conversations.history")).toHaveLength(0);

    await grantAs(stage.agentId, ALEX, "C0REPORTS");
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
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
    const texts = (r: unknown) =>
      (r as { result: { messages: { text: string }[] } }).result.messages.map(
        (m) => m.text,
      );

    const list = await stage.read("direct", ALEX, {});
    expect(list).toMatchObject({
      ok: true,
      result: { readable: ["#weekly-reports"] },
    });
    // The granter fence applies to the list: a shared thread (no verified
    // reader) learns nothing about any share.
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

  it("granter only: the granter's DM and schedule read; Jordan's DM and a shared channel thread are refused identically", async () => {
    script();
    const stage = await seedAgent("audience");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "D0SAM");

    expect(
      (await stage.read("direct", ALEX, { conversation: "@Sam" })).ok,
    ).toBe(true);
    expect((await stage.read("cron", ALEX, { conversation: "@Sam" })).ok).toBe(
      true,
    );

    const before = callsFor("conversations.history").length;
    // Jordan (not connected) in his own thread: a connect card for HIM,
    // nothing about Alex's share.
    const jordan = await stage.read("direct", JORDAN, {
      conversation: "@Sam",
    });
    expect(jordan).toMatchObject({
      ok: true,
      result: { status: "needs_access", reason: "not_connected" },
    });
    // A shared channel thread: the private-chat refusal, no card.
    const shared = await stage.read("channel", ALEX, {
      conversation: "@Sam",
    });
    expect(shared.ok).toBe(false);
    expect(String((shared as { error: string }).error)).toBe(
      "I can only act as Alex in their own private chat with me (the web chat or a DM with me). Ask there.",
    );
    expect(callsFor("conversations.history").length).toBe(before);
    // A schedule someone ELSE created does not carry Alex's access (Jordan
    // gets his own connect card, never Alex's messages).
    expect(
      await stage.read("cron", JORDAN, { conversation: "@Sam" }),
    ).toMatchObject({
      ok: true,
      result: { status: "needs_access", reason: "not_connected" },
    });
    // Alex's OWN schedule that reports into a shared channel is a shared
    // turn: her private DM must not be summarized into that channel.
    expect(
      (
        await stage.read("cron-in-channel", ALEX, {
          conversation: "@Sam",
        })
      ).ok,
    ).toBe(false);
  });

  it("granter only through a schedule: a teammate can neither re-aim and run the granter's schedule nor speak in its run as the granter", async () => {
    script();
    const stage = await seedAgent("schedule-takeover");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "D0SAM");
    // Alex's private schedule: its own fires read Alex's DM.
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

  it("no audience: a channel share reads for nobody but its granter", async () => {
    script();
    const stage = await seedAgent("no-audience");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
    const before = callsFor("conversations.history").length;
    // A different workspace member's OWN direct thread (a card for them,
    // never Alex's read), and a shared thread (refused).
    expect(
      await stage.read("direct", JORDAN, { conversation: "#weekly-reports" }),
    ).toMatchObject({ ok: true, result: { status: "needs_access" } });
    for (const who of [JORDAN, ALEX]) {
      expect(
        (await stage.read("channel", who, { conversation: "#weekly-reports" }))
          .ok,
      ).toBe(false);
    }
    expect(callsFor("conversations.history").length).toBe(before);
    expect(
      (await stage.read("direct", ALEX, { conversation: "#weekly-reports" }))
        .ok,
    ).toBe(true);
  });

  it("disconnect revokes at Slack and removes every grant; the agent then reads nothing", async () => {
    script();
    const stage = await seedAgent("disconnect");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
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
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
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
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
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
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
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
    await grantAs(a.agentId, ALEX, "C0REPORTS");
    await grantAs(a.agentId, ALEX, "D0SAM");
    await grantAs(b.agentId, JORDAN, "C0GENERAL");

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
    const g = await grantAs(stage.agentId, ALEX, "C0REPORTS");
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
        readMode: "allow",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      svc.deleteGrant({ ...foreign, grantId: g.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.agentReadGrant.count({ where: { id: g.id } })).toBe(1);
  });

  it("unlicensed: every act-as-you tool refuses with the Enterprise license message, and Slack is never called", async () => {
    script();
    const stage = await seedAgent("unlicensed");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
    // Unlicensed = neither seam injected (the edition defaults leave both
    // slots null): the tools stay listed, and each says why it can't act.
    const readerSpy = vi
      .spyOn(readerHook, "getConversationReader")
      .mockReturnValue(null);
    const senderSpy = vi
      .spyOn(readerHook, "getConversationSender")
      .mockReturnValue(null);
    try {
      const before = calls.length;
      const ctx = await stage.conversation("direct", ALEX);
      const run = (tool: string, args: unknown) =>
        platformTools.executePlatformTool(`${P}runner-${stage.suffix}`, {
          sandboxId: `${P}sb-${stage.suffix}`,
          tool,
          args,
          ...ctx,
        });
      const refusals = [
        await stage.read("direct", ALEX, { conversation: "#weekly-reports" }),
        await run("send_as_me", {
          conversation: "#weekly-reports",
          text: "hi",
        }),
        await run("edit_my_message", {
          conversation: "#weekly-reports",
          messageId: "1700000000.000100",
          text: "hi",
        }),
        await run("delete_my_message", {
          conversation: "#weekly-reports",
          messageId: "1700000000.000100",
        }),
        await run("send_message", {
          to: "#weekly-reports",
          text: "hi",
          sendAs: "you",
        }),
      ];
      for (const res of refusals) {
        expect(res).toMatchObject({
          ok: false,
          error: "Resource-level access requires a OneCLI Enterprise license.",
        });
      }
      expect(calls.length).toBe(before);
    } finally {
      readerSpy.mockRestore();
      senderSpy.mockRestore();
    }
  });
});

/** Store a token that carries chat:write (a post-scope connection). */
const connectWritable = async (
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
        JSON.stringify({
          accessToken: token,
          scopes: ["channels:history", "chat:write"],
        }),
      ),
    },
    select: { id: true },
  });
};

describe.skipIf(!PROOF_URL)("act as you: read & write modes", () => {
  const send = async (
    stage: Awaited<ReturnType<typeof seedAgent>>,
    where: "direct" | "channel",
    asUser: string,
    args: unknown,
  ) => {
    const ctx = await stage.conversation(where, asUser);
    const res = await platformTools.executePlatformTool(
      `${P}runner-${stage.suffix}`,
      {
        sandboxId: `${P}sb-${stage.suffix}`,
        tool: "send_as_me",
        args,
        ...ctx,
      },
    );
    return { res, ctx };
  };
  const setModes = (
    agentId: string,
    userId: string,
    ref: string,
    modes: {
      readMode?: "allow" | "ask" | "never";
      writeMode?: "allow" | "ask" | "never";
    },
  ) =>
    svc.upsertGrant({
      workspaceId: WORKSPACE,
      agentId,
      userId,
      externalRef: ref,
      ...modes,
    });

  it("new shares read (allow) and never send; the view carries both modes", async () => {
    script();
    const stage = await seedAgent("modes-default");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    const g = await grantAs(stage.agentId, ALEX, "C0REPORTS");
    expect(g).toMatchObject({ readMode: "allow", writeMode: "never" });
  });

  it("canWrite: false for a token without chat:write, true with it; writeMode needs it (422)", async () => {
    script();
    const stage = await seedAgent("modes-canwrite");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    const conn = await svc.getMyConnection({
      workspaceId: WORKSPACE,
      agentId: stage.agentId,
      userId: ALEX,
    });
    expect(conn.canWrite).toBe(false);
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
    await expect(
      setModes(stage.agentId, ALEX, "C0REPORTS", { writeMode: "allow" }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE",
      message: "Reconnect your Slack to let the agent send as you.",
    });
    // never is always allowed.
    const g = await setModes(stage.agentId, ALEX, "C0REPORTS", {
      readMode: "ask",
      writeMode: "never",
    });
    expect(g).not.toHaveProperty("audience");
    expect(g).toMatchObject({
      readMode: "ask",
      writeMode: "never",
    });

    const stage2 = await seedAgent("modes-canwrite2");
    await connectWritable(stage2.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    expect(
      (
        await svc.getMyConnection({
          workspaceId: WORKSPACE,
          agentId: stage2.agentId,
          userId: ALEX,
        })
      ).canWrite,
    ).toBe(true);
    await grantAs(stage2.agentId, ALEX, "C0REPORTS");
    expect(
      await setModes(stage2.agentId, ALEX, "C0REPORTS", { writeMode: "ask" }),
    ).toMatchObject({ writeMode: "ask" });
  });

  it("the OAuth return records the granted scopes (chat:write → canWrite)", async () => {
    script();
    const stage = await seedAgent("modes-oauth");
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
        authed_user: {
          id: "U0ALEX",
          access_token: ALEX_TOKEN,
          scope: "channels:history,chat:write",
        },
      }),
      isActiveMember: async () => true,
    });
    const conn = await svc.getMyConnection({
      workspaceId: WORKSPACE,
      agentId: stage.agentId,
      userId: ALEX,
    });
    expect(conn.canWrite).toBe(true);
  });

  it("readMode never: invisible (not listed, not readable), Slack never called", async () => {
    script();
    const stage = await seedAgent("modes-never");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
    await setModes(stage.agentId, ALEX, "C0REPORTS", { readMode: "never" });
    const list = await stage.read("direct", ALEX, {});
    expect(list).toMatchObject({ ok: true, result: { readable: [] } });
    const res = await stage.read("direct", ALEX, {
      conversation: "#weekly-reports",
    });
    expect(res.ok).toBe(false);
    expect(callsFor("conversations.history")).toHaveLength(0);
    const { channelPresencesForRender } =
      await import("../../services/channels/agent-channel-service");
    const [p] = await channelPresencesForRender(stage.agentId);
    expect(p?.readableConversations).toBeUndefined();
  });

  it("readMode ask: held for the GRANTER only; approving reads and the result rides the outcome", async () => {
    script();
    const stage = await seedAgent("modes-ask");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
    await setModes(stage.agentId, ALEX, "C0REPORTS", { readMode: "ask" });
    // Alex asks in her own thread; the read is still hers to approve.
    const res = await stage.read("direct", ALEX, {
      conversation: "#weekly-reports",
    });
    expect(res).toMatchObject({ ok: true, result: { status: "held" } });
    expect(callsFor("conversations.history")).toHaveLength(0);
    const approval = await db.actionApproval.findFirstOrThrow({
      where: { agentId: stage.agentId, action: "slack_read_as_user" },
      select: { id: true, summary: true, conversationId: true },
    });
    expect(approval.summary).toBe("Read #weekly-reports as Alex");
    expect(approval.conversationId).not.toBeNull();

    const approvals =
      await import("../../services/channels/action-approval-service");
    // Nobody but the granter decides (not even an admin).
    expect(
      await approvals.decideActionApproval({
        approvalId: approval.id,
        decision: "approve",
        deciderUserId: ADMIN,
      }),
    ).toMatchObject({ kind: "refused" });
    // The bell shows it to Alex only.
    const bell =
      await import("../../services/channels/workspace-approvals-service");
    const ids = async (viewer: string) =>
      (await bell.listWorkspacePendingChannelApprovals(WORKSPACE, viewer)).map(
        (i) => i.id,
      );
    expect(await ids(ALEX)).toContain(approval.id);
    expect(await ids(JORDAN)).not.toContain(approval.id);

    const decided = await approvals.decideActionApproval({
      approvalId: approval.id,
      decision: "approve",
      deciderUserId: ALEX,
    });
    expect(decided).toMatchObject({ kind: "decided", status: "executed" });
    expect(callsFor("conversations.history")).toHaveLength(1);
    expect(callsFor("conversations.history")[0]!.auth).toBe(
      `Bearer ${ALEX_TOKEN}`,
    );
    const row = await db.actionApproval.findUniqueOrThrow({
      where: { id: approval.id },
      select: { reason: true },
    });
    expect(row.reason).toContain("second");
    // The result is Alex's Slack: the agent's approvals list (any member's
    // dashboard read) shows the row to Alex only, never to a teammate.
    const listed = async (viewer: string) =>
      (
        await approvals.listActionApprovals({
          workspaceId: WORKSPACE,
          agentId: stage.agentId,
          viewerUserId: viewer,
        })
      ).map((a) => a.id);
    expect(await listed(ALEX)).toContain(approval.id);
    expect(await listed(JORDAN)).not.toContain(approval.id);
    expect(await listed(ADMIN)).not.toContain(approval.id);
  });

  it("ask still applies the granter fence: a shared thread = invisible, nothing held", async () => {
    script();
    const stage = await seedAgent("modes-ask-fence");
    await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
    await setModes(stage.agentId, ALEX, "C0REPORTS", { readMode: "ask" });
    const res = await stage.read("channel", ALEX, {
      conversation: "#weekly-reports",
    });
    expect(res.ok).toBe(false);
    expect(
      await db.actionApproval.count({ where: { agentId: stage.agentId } }),
    ).toBe(0);
  });

  it("send_as_me: allow posts with the granter's token; ask holds; never and a shared thread refuse", async () => {
    script();
    const stage = await seedAgent("send");
    await connectWritable(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
    handlers["chat.postMessage"] = () => ({
      channel: "C0REPORTS",
      ts: nextTs(),
    });

    // never (the default): an access card (write_off), nothing posted.
    let out = await send(stage, "direct", ALEX, {
      conversation: "#weekly-reports",
      text: "hello",
    });
    expect(out.res).toMatchObject({
      ok: true,
      result: { status: "needs_access", reason: "write_off" },
    });
    expect(callsFor("chat.postMessage")).toHaveLength(0);

    await setModes(stage.agentId, ALEX, "C0REPORTS", { writeMode: "allow" });
    const { channelPresencesForRender } =
      await import("../../services/channels/agent-channel-service");
    expect((await channelPresencesForRender(stage.agentId))[0]).toMatchObject({
      readableConversations: 1,
    });
    // A shared thread resolves to nobody: refused even for the granter.
    out = await send(stage, "channel", ALEX, {
      conversation: "#weekly-reports",
      text: "hello",
    });
    expect(out.res.ok).toBe(false);
    expect(String((out.res as { error: string }).error)).toMatch(
      /only act as Alex in their own private chat/,
    );
    // Someone else's private thread: a card for THEM (not connected).
    out = await send(stage, "direct", JORDAN, {
      conversation: "#weekly-reports",
      text: "hello",
    });
    expect(out.res).toMatchObject({
      ok: true,
      result: { status: "needs_access", reason: "not_connected" },
    });
    expect(callsFor("chat.postMessage")).toHaveLength(0);

    out = await send(stage, "direct", ALEX, {
      conversation: "#weekly-reports",
      text: "hello <team>",
    });
    expect(out.res).toMatchObject({ ok: true, result: { status: "sent" } });
    const [post] = callsFor("chat.postMessage");
    expect(post!.auth).toBe(`Bearer ${ALEX_TOKEN}`);
    expect(post!.form.get("channel")).toBe("C0REPORTS");
    expect(post!.form.get("text")).toBe("hello &lt;team&gt;");
    expect(
      await db.auditLog.count({
        where: {
          workspaceId: WORKSPACE,
          metadata: { path: ["sendAsUser"], equals: "sent" },
        },
      }),
    ).toBeGreaterThan(0);

    // ask: held for Alex; approving posts.
    await setModes(stage.agentId, ALEX, "C0REPORTS", { writeMode: "ask" });
    out = await send(stage, "direct", ALEX, {
      conversation: "#weekly-reports",
      text: "second",
    });
    expect(out.res).toMatchObject({ ok: true, result: { status: "held" } });
    expect(callsFor("chat.postMessage")).toHaveLength(1);
    const approval = await db.actionApproval.findFirstOrThrow({
      where: { agentId: stage.agentId, action: "slack_send_as_user" },
      select: { id: true },
    });
    const approvals =
      await import("../../services/channels/action-approval-service");
    expect(
      await approvals.decideActionApproval({
        approvalId: approval.id,
        decision: "approve",
        deciderUserId: ALEX,
      }),
    ).toMatchObject({ status: "executed" });
    expect(callsFor("chat.postMessage")).toHaveLength(2);
  });

  it("send_as_me never guesses: a partial name posts nothing (reads still forgive one)", async () => {
    script();
    const stage = await seedAgent("send-exact");
    await connectWritable(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
    await setModes(stage.agentId, ALEX, "C0REPORTS", { writeMode: "allow" });
    handlers["chat.postMessage"] = () => ({
      channel: "C0REPORTS",
      ts: nextTs(),
    });

    // "weekly" is a unique partial of #weekly-reports: fine to READ...
    expect(
      await stage.read("direct", ALEX, { conversation: "weekly" }),
    ).toMatchObject({ ok: true, result: { conversation: "#weekly-reports" } });
    // ...but a write as Alex must name it exactly: no post, no guess.
    const out = await send(stage, "direct", ALEX, {
      conversation: "weekly",
      text: "hello",
    });
    expect(out.res.ok).toBe(false);
    expect(String((out.res as { error: string }).error)).toMatch(
      /aren't in a Slack conversation matching weekly\. Nothing was sent\./,
    );
    expect(callsFor("chat.postMessage")).toHaveLength(0);
  });

  describe("edit_my_message / delete_my_message: only its own sends as you", () => {
    const tool = async (
      stage: Awaited<ReturnType<typeof seedAgent>>,
      name: "edit_my_message" | "delete_my_message",
      asUser: string,
      args: unknown,
      where: "direct" | "channel" = "direct",
    ) => {
      const ctx = await stage.conversation(where, asUser);
      return platformTools.executePlatformTool(`${P}runner-${stage.suffix}`, {
        sandboxId: `${P}sb-${stage.suffix}`,
        tool: name,
        args,
        ...ctx,
      });
    };
    const approvalsMod = () =>
      import("../../services/channels/action-approval-service");
    const sentOne = async (suffix: string) => {
      script();
      const stage = await seedAgent(suffix);
      await connectWritable(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
      await grantAs(stage.agentId, ALEX, "C0REPORTS");
      await setModes(stage.agentId, ALEX, "C0REPORTS", { writeMode: "allow" });
      handlers["chat.postMessage"] = () => ({
        channel: "C0REPORTS",
        ts: nextTs(),
      });
      const out = await send(stage, "direct", ALEX, {
        conversation: "#weekly-reports",
        text: "original",
      });
      const messageId = (out.res as { result: { messageId: string } }).result
        .messageId;
      expect(messageId).toMatch(/^\d+\.\d+$/);
      return { stage, messageId };
    };

    it("send_as_me records the post and returns its messageId; edit (allow) updates with the granter's token and audits", async () => {
      const { stage, messageId } = await sentOne("edit-allow");
      expect(
        await db.agentSentAsUser.count({
          where: { agentId: stage.agentId, messageTs: messageId },
        }),
      ).toBe(1);
      const res = await tool(stage, "edit_my_message", ALEX, {
        conversation: "#weekly-reports",
        messageId,
        text: "fixed <x>",
      });
      expect(res).toMatchObject({ ok: true, result: { status: "edited" } });
      const [upd] = callsFor("chat.update");
      expect(upd!.auth).toBe(`Bearer ${ALEX_TOKEN}`);
      expect(upd!.form.get("channel")).toBe("C0REPORTS");
      expect(upd!.form.get("ts")).toBe(messageId);
      expect(upd!.form.get("text")).toBe("fixed &lt;x&gt;");
      const audits = await db.auditLog.findMany({
        where: {
          workspaceId: WORKSPACE,
          metadata: { path: ["editAsUser"], equals: "done" },
        },
        select: { metadata: true },
      });
      expect(audits.length).toBeGreaterThan(0);
      expect(JSON.stringify(audits)).not.toContain("fixed");
    });

    it("refuses a message it never recorded, one older than 24h, another person's, and a shared turn", async () => {
      const { stage, messageId } = await sentOne("edit-refuse");
      const refusal = /only change messages I sent as you in the last 24 hours/;
      // Never recorded.
      let res = await tool(stage, "edit_my_message", ALEX, {
        conversation: "#weekly-reports",
        messageId: "1600000000.000001",
        text: "x",
      });
      expect(String((res as { error: string }).error)).toMatch(refusal);
      // Another person's token (Jordan, own writable grant) can't touch it.
      await connectWritable(stage.presenceId, JORDAN, "U0JORDAN", JORDAN_TOKEN);
      res = await tool(stage, "edit_my_message", JORDAN, {
        conversation: "#weekly-reports",
        messageId,
        text: "x",
      });
      expect(res.ok).toBe(false);
      // A shared turn: the private-chat refusal.
      res = await tool(
        stage,
        "delete_my_message",
        ALEX,
        { conversation: "#weekly-reports", messageId },
        "channel",
      );
      expect(String((res as { error: string }).error)).toMatch(
        /only act as Alex in their own private chat/,
      );
      // Older than 24h.
      await db.agentSentAsUser.updateMany({
        where: { messageTs: messageId },
        data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      res = await tool(stage, "edit_my_message", ALEX, {
        conversation: "#weekly-reports",
        messageId,
        text: "x",
      });
      expect(String((res as { error: string }).error)).toMatch(refusal);
      expect(callsFor("chat.update")).toHaveLength(0);
      expect(callsFor("chat.delete")).toHaveLength(0);
    });

    it("writeMode never: needs_access (write_off), nothing changed", async () => {
      const { stage, messageId } = await sentOne("edit-never");
      await setModes(stage.agentId, ALEX, "C0REPORTS", { writeMode: "never" });
      const res = await tool(stage, "edit_my_message", ALEX, {
        conversation: "#weekly-reports",
        messageId,
        text: "x",
      });
      expect(res).toMatchObject({
        ok: true,
        result: { status: "needs_access", reason: "write_off" },
      });
      expect(callsFor("chat.update")).toHaveLength(0);
    });

    it("edit on ask holds for the granter; approving edits", async () => {
      const { stage, messageId } = await sentOne("edit-ask");
      await setModes(stage.agentId, ALEX, "C0REPORTS", { writeMode: "ask" });
      const res = await tool(stage, "edit_my_message", ALEX, {
        conversation: "#weekly-reports",
        messageId,
        text: "later",
      });
      expect(res).toMatchObject({ ok: true, result: { status: "held" } });
      const approval = await db.actionApproval.findFirstOrThrow({
        where: { agentId: stage.agentId, action: "slack_edit_as_user" },
        select: { id: true, summary: true },
      });
      expect(approval.summary).toContain("later");
      expect(
        await (
          await approvalsMod()
        ).decideActionApproval({
          approvalId: approval.id,
          decision: "approve",
          deciderUserId: ALEX,
        }),
      ).toMatchObject({ status: "executed" });
      expect(callsFor("chat.update")).toHaveLength(1);
    });

    it("delete is always held (even on allow), shows the text, only the granter decides, approve deletes", async () => {
      const { stage, messageId } = await sentOne("delete");
      handlers["conversations.history"] = () => ({
        messages: [{ ts: messageId, user: "U0ALEX", text: "original" }],
      });
      const res = await tool(stage, "delete_my_message", ALEX, {
        conversation: "#weekly-reports",
        messageId,
      });
      expect(res).toMatchObject({ ok: true, result: { status: "held" } });
      expect(callsFor("chat.delete")).toHaveLength(0);
      const hist = callsFor("conversations.history").at(-1)!;
      expect(hist.auth).toBe(`Bearer ${ALEX_TOKEN}`);
      expect(hist.form.get("latest")).toBe(messageId);
      expect(hist.form.get("inclusive")).toBe("true");
      const approval = await db.actionApproval.findFirstOrThrow({
        where: { agentId: stage.agentId, action: "slack_delete_as_user" },
        select: { id: true, summary: true },
      });
      expect(approval.summary).toContain("original");
      const approvals = await approvalsMod();
      expect(
        await approvals.decideActionApproval({
          approvalId: approval.id,
          decision: "approve",
          deciderUserId: ADMIN,
        }),
      ).toMatchObject({ kind: "refused" });
      expect(callsFor("chat.delete")).toHaveLength(0);
      expect(
        await approvals.decideActionApproval({
          approvalId: approval.id,
          decision: "approve",
          deciderUserId: ALEX,
        }),
      ).toMatchObject({ status: "executed" });
      const [del] = callsFor("chat.delete");
      expect(del!.auth).toBe(`Bearer ${ALEX_TOKEN}`);
      expect(del!.form.get("ts")).toBe(messageId);
      expect(
        await db.agentSentAsUser.count({ where: { messageTs: messageId } }),
      ).toBe(0);
      expect(
        await db.auditLog.count({
          where: {
            workspaceId: WORKSPACE,
            metadata: { path: ["deleteAsUser"], equals: "done" },
          },
        }),
      ).toBeGreaterThan(0);
    });
  });

  it("send_as_me: a held send dies if the mode turns to never before approval", async () => {
    script();
    const stage = await seedAgent("send-revoked");
    await connectWritable(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
    await setModes(stage.agentId, ALEX, "C0REPORTS", { writeMode: "ask" });
    await send(stage, "direct", ALEX, {
      conversation: "#weekly-reports",
      text: "x",
    });
    await setModes(stage.agentId, ALEX, "C0REPORTS", { writeMode: "never" });
    const approval = await db.actionApproval.findFirstOrThrow({
      where: { agentId: stage.agentId, action: "slack_send_as_user" },
      select: { id: true },
    });
    const approvals =
      await import("../../services/channels/action-approval-service");
    expect(
      await approvals.decideActionApproval({
        approvalId: approval.id,
        decision: "approve",
        deciderUserId: ALEX,
      }),
    ).toMatchObject({ status: "failed" });
    expect(callsFor("chat.postMessage")).toHaveLength(0);
  });

  describe("needs_access: a card instead of a dead end", () => {
    const approvalsMod = () =>
      import("../../services/channels/action-approval-service");
    const accessRows = (agentId: string) =>
      db.actionApproval.findMany({
        where: { agentId, action: "slack_access_request" },
        select: {
          id: true,
          status: true,
          summary: true,
          payload: true,
          cardRefs: true,
          reason: true,
        },
      });

    it("not connected: needs_access + ONE deduped request, no Slack DM card; Connect settles it", async () => {
      script();
      const stage = await seedAgent("na-connect");
      const ask = () =>
        stage.read("direct", ALEX, { conversation: "#weekly-reports" });
      const first = await ask();
      expect(first).toMatchObject({
        ok: true,
        result: {
          status: "needs_access",
          reason: "not_connected",
          conversation: "#weekly-reports",
        },
      });
      const second = await ask();
      const rows = await accessRows(stage.agentId);
      expect(rows).toHaveLength(1);
      expect(
        (second as { result: { accessRequestId: string } }).result
          .accessRequestId,
      ).toBe(rows[0]!.id);
      expect(rows[0]!.summary).toBe(
        "Connect your Slack so Helper na-connect can read as you",
      );
      expect(rows[0]!.cardRefs).toEqual([]);
      expect(callsFor("chat.postMessage")).toHaveLength(0);

      const approvals = await approvalsMod();
      // Not approvable by click, even by its own person.
      expect(
        await approvals.decideActionApproval({
          approvalId: rows[0]!.id,
          decision: "approve",
          deciderUserId: ALEX,
        }),
      ).toMatchObject({ kind: "refused" });
      // The bell shows it to Alex only, with the structured view.
      const bell =
        await import("../../services/channels/workspace-approvals-service");
      const mine = await bell.listWorkspacePendingChannelApprovals(
        WORKSPACE,
        ALEX,
      );
      expect(mine.find((i) => i.id === rows[0]!.id)).toMatchObject({
        slackAccess: { kind: "read", reason: "not_connected" },
      });
      expect(
        (
          await bell.listWorkspacePendingChannelApprovals(WORKSPACE, JORDAN)
        ).map((i) => i.id),
      ).not.toContain(rows[0]!.id);

      // Completing Connect settles it.
      handlers["oauth.v2.access"] = () => ({
        team: { id: TEAM },
        authed_user: {
          id: "U0ALEX",
          access_token: ALEX_TOKEN,
          scope: "channels:history",
        },
      });
      await svc.completeConnect({
        state: {
          kind: "slack-user-read",
          workspaceId: WORKSPACE,
          agentId: stage.agentId,
          presenceId: stage.presenceId,
          userId: ALEX,
          issuedAt: Date.now(),
          nonce: "n",
        } as never,
        code: "c",
        redirectUri: "http://x",
        exchange: async () => ({
          team: { id: TEAM },
          authed_user: {
            id: "U0ALEX",
            access_token: ALEX_TOKEN,
            scope: "channels:history",
          },
        }),
        isActiveMember: async () => true,
      });
      const [settled] = await accessRows(stage.agentId);
      expect(settled).toMatchObject({
        status: "executed",
        reason: "Slack connected; ask again",
      });
    });

    it("not connected: the note addresses the asker as you (by name), the bell hides nothing server-side, and Not now rejects it", async () => {
      script();
      const stage = await seedAgent("na-dismiss");
      const res = (await stage.read("direct", ALEX, {
        conversation: "#weekly-reports",
      })) as { result: { note: string; accessRequestId: string } };
      const alex = await db.user.findUniqueOrThrow({
        where: { id: ALEX },
        select: { name: true, email: true },
      });
      expect(res.result.note).toContain(
        `A card in this chat asks you (${alex.name || alex.email}) to connect your Slack.`,
      );
      expect(res.result.note).not.toMatch(/asks them/);
      const approvals = await approvalsMod();
      // Someone else can't dismiss it; the asker can (reject is allowed
      // on a connect request even though approve is not).
      expect(
        await approvals.decideActionApproval({
          approvalId: res.result.accessRequestId,
          decision: "reject",
          deciderUserId: JORDAN,
        }),
      ).toMatchObject({ kind: "refused" });
      expect(
        await approvals.decideActionApproval({
          approvalId: res.result.accessRequestId,
          decision: "reject",
          deciderUserId: ALEX,
        }),
      ).toMatchObject({ kind: "decided", status: "rejected" });
      // A rejection never wakes the chat.
      expect(
        await db.turn.count({
          where: {
            conversation: { agentId: stage.agentId },
            source: "approval",
          },
        }),
      ).toBe(0);
    });

    it("not shared: needs_access + request; only the reader decides; approve creates the grant (read allow, write never) and returns the read", async () => {
      script();
      const stage = await seedAgent("na-share");
      await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
      const res = await stage.read("direct", ALEX, { conversation: "weekly" });
      expect(res).toMatchObject({
        ok: true,
        result: {
          status: "needs_access",
          reason: "not_shared",
          conversation: "#weekly-reports",
        },
      });
      await stage.read("direct", ALEX, { conversation: "weekly" });
      const rows = await accessRows(stage.agentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.summary).toBe(
        "Let Helper na-share read #weekly-reports as you",
      );
      expect(callsFor("conversations.history")).toHaveLength(0);

      const approvals = await approvalsMod();
      for (const other of [ADMIN, JORDAN]) {
        expect(
          await approvals.decideActionApproval({
            approvalId: rows[0]!.id,
            decision: "approve",
            deciderUserId: other,
          }),
        ).toMatchObject({ kind: "refused" });
      }
      expect(
        await approvals.decideActionApproval({
          approvalId: rows[0]!.id,
          decision: "approve",
          deciderUserId: ALEX,
        }),
      ).toMatchObject({ kind: "decided", status: "executed" });
      const grant = await db.agentReadGrant.findFirstOrThrow({
        where: { userToken: { agentChannelId: stage.presenceId } },
        select: { externalRef: true, readMode: true, writeMode: true },
      });
      expect(grant).toEqual({
        externalRef: "C0REPORTS",
        readMode: "allow",
        writeMode: "never",
      });
      const [done] = await accessRows(stage.agentId);
      expect(done!.reason).toContain("second");
      expect(callsFor("conversations.history")[0]!.auth).toBe(
        `Bearer ${ALEX_TOKEN}`,
      );
      // The approve woke Alex's own chat (the origin) with a platform turn.
      const resumed = await db.turn.findMany({
        where: { conversation: { agentId: stage.agentId }, source: "approval" },
        select: {
          userId: true,
          message: true,
          conversation: { select: { direct: true, userId: true } },
        },
      });
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({
        userId: null,
        conversation: { direct: true, userId: ALEX },
      });
      expect(resumed[0]!.message).toMatch(
        /^The person approved: .*Continue the original request\.$/,
      );
    });

    it("a name matching none of the reader's conversations is answered now, no request", async () => {
      script();
      const stage = await seedAgent("na-none");
      await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
      const res = await stage.read("direct", ALEX, { conversation: "#nope" });
      expect(res.ok).toBe(false);
      expect(await accessRows(stage.agentId)).toHaveLength(0);
    });

    it("null reader (shared thread): refused with the private-chat line, no request", async () => {
      script();
      const stage = await seedAgent("na-null");
      const res = await stage.read("channel", ALEX, {
        conversation: "#weekly-reports",
      });
      expect(res).toEqual({
        ok: false,
        error:
          "I can only act as Alex in their own private chat with me (the web chat or a DM with me). Ask there.",
      });
      const out = await send(stage, "channel", ALEX, {
        conversation: "#weekly-reports",
        text: "hi",
      });
      expect(out.res.ok).toBe(false);
      expect(await accessRows(stage.agentId)).toHaveLength(0);
    });

    it("send_as_me write_off: approve sets writeMode allow and sends; not_shared write creates a write-only grant", async () => {
      script();
      handlers["chat.postMessage"] = () => ({
        channel: "C0REPORTS",
        ts: nextTs(),
      });
      const stage = await seedAgent("na-write");
      await connectWritable(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
      // not shared at all → not_shared (write)
      const out = await send(stage, "direct", ALEX, {
        conversation: "#weekly-reports",
        text: "hello all",
      });
      expect(out.res).toMatchObject({
        ok: true,
        result: { status: "needs_access", reason: "not_shared" },
      });
      const [row] = await accessRows(stage.agentId);
      expect(row!.summary).toBe(
        "Let Helper na-write write in #weekly-reports as you?",
      );
      const approvals = await approvalsMod();
      expect(
        await approvals.decideActionApproval({
          approvalId: row!.id,
          decision: "approve",
          deciderUserId: ALEX,
        }),
      ).toMatchObject({ status: "executed" });
      // Allowing a write is not allowing the history to be read.
      expect(
        await db.agentReadGrant.findFirstOrThrow({
          where: { userToken: { agentChannelId: stage.presenceId } },
          select: { readMode: true, writeMode: true },
        }),
      ).toEqual({ readMode: "never", writeMode: "allow" });
      expect(callsFor("chat.postMessage")).toHaveLength(1);
      expect(callsFor("chat.postMessage")[0]!.form.get("text")).toBe(
        "hello all",
      );

      // write_off on an existing grant: approve flips it to allow.
      await setModes(stage.agentId, ALEX, "C0REPORTS", { writeMode: "never" });
      const off = await send(stage, "direct", ALEX, {
        conversation: "#weekly-reports",
        text: "again",
      });
      expect(off.res).toMatchObject({
        result: { status: "needs_access", reason: "write_off" },
      });
      const pending = (await accessRows(stage.agentId)).find(
        (r) => r.status === "pending",
      )!;
      await approvals.decideActionApproval({
        approvalId: pending.id,
        decision: "approve",
        deciderUserId: ALEX,
      });
      expect(callsFor("chat.postMessage")).toHaveLength(2);
    });

    it("send_as_me renders @[Name] as a real mention, even for someone the agent's contacts block", async () => {
      script();
      handlers["chat.postMessage"] = () => ({
        channel: "C0REPORTS",
        ts: nextTs(),
      });
      const stage = await seedAgent("na-mention");
      await connectWritable(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
      await grantAs(stage.agentId, ALEX, "C0REPORTS");
      await setModes(stage.agentId, ALEX, "C0REPORTS", { writeMode: "allow" });
      // Alex is a linked teammate; block her on the agent's contacts.
      const { integrationId } = await db.agentChannel.findUniqueOrThrow({
        where: { id: stage.presenceId },
        select: { integrationId: true },
      });
      await db.agentReachGrant.create({
        data: {
          agentId: stage.agentId,
          integrationId,
          provider: "slack",
          subjectKind: "external_user",
          externalRef: "U0ALEX",
          state: "blocked",
          cardRefs: [],
        },
      });
      const out = await send(stage, "direct", ALEX, {
        conversation: "#weekly-reports",
        text: "@[Alex] **how's** life? <!channel> @[Nobody]",
      });
      expect(out.res).toMatchObject({ result: { status: "sent" } });
      // The same markdown renderer as the agent's own posts: **bold**
      // becomes Slack bold, never literal asterisks.
      expect(callsFor("chat.postMessage")[0]!.form.get("text")).toBe(
        "<@U0ALEX> *how's* life? &lt;!channel&gt; @Nobody",
      );
    });

    it("send_as_me without chat:write: reconnect_for_write (not approvable; Connect with write settles it)", async () => {
      script();
      const stage = await seedAgent("na-reconnect");
      await connectAs(stage.presenceId, ALEX, "U0ALEX", ALEX_TOKEN);
      await grantAs(stage.agentId, ALEX, "C0REPORTS");
      const out = await send(stage, "direct", ALEX, {
        conversation: "#weekly-reports",
        text: "hi",
      });
      expect(out.res).toMatchObject({
        result: { status: "needs_access", reason: "reconnect_for_write" },
      });
      const [row] = await accessRows(stage.agentId);
      expect(row!.summary).toBe(
        "Reconnect your Slack so Helper na-reconnect can write as you",
      );
      const approvals = await approvalsMod();
      expect(
        await approvals.decideActionApproval({
          approvalId: row!.id,
          decision: "approve",
          deciderUserId: ALEX,
        }),
      ).toMatchObject({ kind: "refused" });
    });
  });
});

describe.skipIf(!PROOF_URL)("send_message: choose who sends", () => {
  const CHOOSE = "channel.choose_sender";
  const tool = async (
    stage: Awaited<ReturnType<typeof seedAgent>>,
    where: "direct" | "channel",
    asUser: string,
    args: Record<string, unknown>,
  ) => {
    const ctx = await stage.conversation(where, asUser);
    return platformTools.executePlatformTool(`${P}runner-${stage.suffix}`, {
      sandboxId: `${P}sb-${stage.suffix}`,
      tool: "send_message",
      args: { to: "#weekly-reports", text: "ship it", ...args },
      ...ctx,
    });
  };
  const approvals = () =>
    import("../../services/channels/action-approval-service");
  /** The bot sees #weekly-reports, and the agent may post there. */
  const stageWithChannel = async (suffix: string) => {
    script();
    handlers["conversations.list"] = () => ({
      channels: [{ id: "C0REPORTS", name: "weekly-reports", is_member: true }],
      response_metadata: { next_cursor: "" },
    });
    handlers["chat.postMessage"] = (c) => ({
      channel: c.form.get("channel"),
      ts: nextTs(),
    });
    const stage = await seedAgent(suffix);
    const { integrationId } = await db.agentChannel.findUniqueOrThrow({
      where: { id: stage.presenceId },
      select: { integrationId: true },
    });
    await db.agentReachGrant.create({
      data: {
        agentId: stage.agentId,
        integrationId,
        provider: "slack",
        subjectKind: "space",
        externalRef: "C0REPORTS",
        subjectLabel: "#weekly-reports",
        state: "approved",
        cardRefs: [],
      },
    });
    return stage;
  };
  const writable = async (stage: Awaited<ReturnType<typeof seedAgent>>) => {
    const { getCrypto } = await import("../../providers");
    await db.agentChannelUserToken.create({
      data: {
        agentChannelId: stage.presenceId,
        userId: ALEX,
        externalUserId: "U0ALEX",
        credentials: await getCrypto().encrypt(
          JSON.stringify({
            accessToken: ALEX_TOKEN,
            scopes: ["channels:history", "chat:write"],
          }),
        ),
      },
    });
    await grantAs(stage.agentId, ALEX, "C0REPORTS");
    await svc.upsertGrant({
      workspaceId: WORKSPACE,
      agentId: stage.agentId,
      userId: ALEX,
      externalRef: "C0REPORTS",
      writeMode: "allow",
    });
  };
  const posts = () => callsFor("chat.postMessage");
  const chooseRows = (agentId: string) =>
    db.actionApproval.findMany({
      where: { agentId, action: CHOOSE },
      select: { id: true, status: true, reason: true, summary: true },
    });
  const pref = (agentId: string) =>
    db.agentSendAsPreference.findFirst({
      where: { agentId, userId: ALEX, recipientRef: "C0REPORTS" },
      select: { sendAs: true },
    });

  it("a shared place (no verified reader): sends as the agent, no card", async () => {
    const stage = await stageWithChannel("cs-shared");
    const res = await tool(stage, "channel", ALEX, {});
    expect(res).toMatchObject({ ok: true, result: { status: "sent" } });
    expect(posts()[0]!.auth).toBe("Bearer xoxb-bot");
    expect(await chooseRows(stage.agentId)).toHaveLength(0);
  });

  it("ask: a card for the reader even when NOT connected; only the reader decides", async () => {
    const stage = await stageWithChannel("cs-card");
    const res = await tool(stage, "direct", ALEX, {});
    expect(res).toMatchObject({
      ok: true,
      result: { status: "needs_choice", to: "#weekly-reports" },
    });
    expect(String((res as { result: { note: string } }).result.note)).toMatch(
      /asks you \(Alex\) how Helper cs-card should message #weekly-reports/,
    );
    expect(posts()).toHaveLength(0);
    // Asking again reuses the same card.
    await tool(stage, "direct", ALEX, {});
    const rows = await chooseRows(stage.agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe(
      `How should Helper cs-card message #weekly-reports? "ship it"`,
    );
    const a = await approvals();
    expect(
      await a.decideActionApproval({
        approvalId: rows[0]!.id,
        decision: "approve",
        choice: "agent",
        deciderUserId: JORDAN,
      }),
    ).toMatchObject({ kind: "refused" });
    // A plain approve without a choice is refused too.
    expect(
      await a.decideActionApproval({
        approvalId: rows[0]!.id,
        decision: "approve",
        deciderUserId: ALEX,
      }),
    ).toMatchObject({ kind: "refused" });
  });

  it("Don't send: nothing sent, nothing remembered", async () => {
    const stage = await stageWithChannel("cs-cancel");
    await tool(stage, "direct", ALEX, {});
    const [row] = await chooseRows(stage.agentId);
    expect(
      await (
        await approvals()
      ).decideActionApproval({
        approvalId: row!.id,
        decision: "reject",
        deciderUserId: ALEX,
      }),
    ).toMatchObject({ kind: "decided", status: "rejected" });
    expect(posts()).toHaveLength(0);
    expect(await pref(stage.agentId)).toBeNull();
  });

  it("pick agent: sends as the agent, remembers it; the next send skips the card (remembered)", async () => {
    const stage = await stageWithChannel("cs-agent");
    await tool(stage, "direct", ALEX, {});
    const [row] = await chooseRows(stage.agentId);
    const out = await (
      await approvals()
    ).decideActionApproval({
      approvalId: row!.id,
      decision: "approve",
      choice: "agent",
      deciderUserId: ALEX,
    });
    expect(out).toMatchObject({ kind: "decided", status: "executed" });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.auth).toBe("Bearer xoxb-bot");
    expect((await chooseRows(stage.agentId))[0]!.reason).toMatch(
      /^Sent as Helper cs-agent to #weekly-reports: "/,
    );
    expect(await pref(stage.agentId)).toEqual({ sendAs: "agent" });

    const next = await tool(stage, "direct", ALEX, { text: "again" });
    expect(next).toMatchObject({
      ok: true,
      result: { status: "sent", sendAs: "agent", remembered: true },
    });
    expect(await chooseRows(stage.agentId)).toHaveLength(1);
  });

  it("pick you (connected, writing allowed): sent with the person's token; an explicit opposite overrides AND updates", async () => {
    const stage = await stageWithChannel("cs-you");
    await writable(stage);
    await tool(stage, "direct", ALEX, {});
    const [row] = await chooseRows(stage.agentId);
    await (
      await approvals()
    ).decideActionApproval({
      approvalId: row!.id,
      decision: "approve",
      choice: "you",
      deciderUserId: ALEX,
    });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.auth).toBe(`Bearer ${ALEX_TOKEN}`);
    expect(await pref(stage.agentId)).toEqual({ sendAs: "you" });

    const remembered = await tool(stage, "direct", ALEX, { text: "two" });
    expect(remembered).toMatchObject({
      result: { status: "sent", sendAs: "you", remembered: true },
    });
    expect(posts()[1]!.auth).toBe(`Bearer ${ALEX_TOKEN}`);

    const switched = await tool(stage, "direct", ALEX, {
      text: "three",
      sendAs: "agent",
    });
    expect(switched).toMatchObject({
      result: { status: "sent", sendAs: "agent", preferenceUpdated: true },
    });
    expect(posts()[2]!.auth).toBe("Bearer xoxb-bot");
    expect(await pref(stage.agentId)).toEqual({ sendAs: "agent" });
  });

  it("pick you, connected, writing off: the pick allows writing (persisted) and sends, no write card", async () => {
    const stage = await stageWithChannel("cs-you-never");
    await writable(stage);
    await svc.upsertGrant({
      workspaceId: WORKSPACE,
      agentId: stage.agentId,
      userId: ALEX,
      externalRef: "C0REPORTS",
      writeMode: "never",
    });
    await tool(stage, "direct", ALEX, {});
    const [row] = await chooseRows(stage.agentId);
    expect(
      await (
        await approvals()
      ).decideActionApproval({
        approvalId: row!.id,
        decision: "approve",
        choice: "you",
        deciderUserId: ALEX,
      }),
    ).toMatchObject({ kind: "decided", status: "executed" });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.auth).toBe(`Bearer ${ALEX_TOKEN}`);
    expect(
      await db.actionApproval.count({
        where: { agentId: stage.agentId, action: "slack_access_request" },
      }),
    ).toBe(0);
    const grant = await db.agentReadGrant.findFirstOrThrow({
      where: {
        externalRef: "C0REPORTS",
        userToken: { userId: ALEX, agentChannelId: stage.presenceId },
      },
      select: { writeMode: true, readMode: true },
    });
    expect(grant).toEqual({ writeMode: "allow", readMode: "allow" });
  });

  it("pick you, connected, never shared: shared with writing allowed by the pick, and sent", async () => {
    const stage = await stageWithChannel("cs-you-unshared");
    const { getCrypto } = await import("../../providers");
    await db.agentChannelUserToken.create({
      data: {
        agentChannelId: stage.presenceId,
        userId: ALEX,
        externalUserId: "U0ALEX",
        credentials: await getCrypto().encrypt(
          JSON.stringify({
            accessToken: ALEX_TOKEN,
            scopes: ["channels:history", "chat:write"],
          }),
        ),
      },
    });
    await tool(stage, "direct", ALEX, {});
    const [row] = await chooseRows(stage.agentId);
    await (
      await approvals()
    ).decideActionApproval({
      approvalId: row!.id,
      decision: "approve",
      choice: "you",
      deciderUserId: ALEX,
    });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.auth).toBe(`Bearer ${ALEX_TOKEN}`);
    expect(
      await db.actionApproval.count({
        where: { agentId: stage.agentId, action: "slack_access_request" },
      }),
    ).toBe(0);
    // Consent to send there is not consent to read its history: the share
    // the pick made writes, and reads nothing until Alex turns reading on.
    const made = await db.agentReadGrant.findFirstOrThrow({
      where: { userToken: { userId: ALEX, agentChannelId: stage.presenceId } },
      select: { writeMode: true, readMode: true },
    });
    expect(made).toEqual({ writeMode: "allow", readMode: "never" });
  });

  it("not connected → card → pick you → Connect card (chained) → connect completes → sent as the person", async () => {
    const stage = await stageWithChannel("cs-connect");
    await tool(stage, "direct", ALEX, {});
    const [row] = await chooseRows(stage.agentId);
    const out = await (
      await approvals()
    ).decideActionApproval({
      approvalId: row!.id,
      decision: "approve",
      choice: "you",
      deciderUserId: ALEX,
    });
    expect(out).toMatchObject({ kind: "decided", status: "executed" });
    expect(posts()).toHaveLength(0);
    expect((await chooseRows(stage.agentId))[0]!.reason).toMatch(
      /^One more step: connect your Slack so the message can go as you\./,
    );
    const connect = await db.actionApproval.findFirstOrThrow({
      where: { agentId: stage.agentId, action: "slack_access_request" },
      select: { id: true, payload: true, status: true },
    });
    expect(connect).toMatchObject({
      status: "pending",
      payload: { reason: "not_connected", kind: "write", text: "ship it" },
    });

    const exchange = async () => ({
      team: { id: TEAM },
      authed_user: {
        id: "U0ALEX",
        access_token: ALEX_TOKEN,
        scope: "channels:history,chat:write",
      },
    });
    await svc.completeConnect({
      state: {
        kind: "slack-user-read",
        workspaceId: WORKSPACE,
        agentId: stage.agentId,
        presenceId: stage.presenceId,
        userId: ALEX,
        issuedAt: Date.now(),
        nonce: "n",
      } as never,
      code: "c",
      redirectUri: "http://x",
      exchange,
      isActiveMember: async () => true,
    });
    const settled = await db.actionApproval.findUniqueOrThrow({
      where: { id: connect.id },
      select: { status: true, reason: true },
    });
    expect(settled.status).toBe("executed");
    // The pick was the consent: connect was the only extra step, and the
    // message goes out as the person with no share / write card.
    expect(settled.reason).toMatch(/^Sent as you to /);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.auth).toBe(`Bearer ${ALEX_TOKEN}`);
    expect(
      await db.actionApproval.count({
        where: {
          agentId: stage.agentId,
          action: "slack_access_request",
          status: "pending",
        },
      }),
    ).toBe(0);
    expect(connect.payload).toMatchObject({ consented: true });
  });

  /** Sam is anchored in Alex's chat and blocked (Can talk with = Never). */
  const blockedSam = async (suffix: string) => {
    const stage = await stageWithChannel(suffix);
    handlers["conversations.open"] = () => ({ channel: { id: "D0BOTSAM" } });
    const { integrationId } = await db.agentChannel.findUniqueOrThrow({
      where: { id: stage.presenceId },
      select: { integrationId: true },
    });
    await db.agentReachGrant.create({
      data: {
        agentId: stage.agentId,
        integrationId,
        provider: "slack",
        subjectKind: "external_user",
        externalRef: "U0SAM",
        subjectLabel: "Sam",
        state: "blocked",
        cardRefs: [],
      },
    });
    const { conversationId } = await stage.conversation("direct", ALEX);
    const search =
      await import("../../services/channels/recipient-search-service");
    await search.anchorRecipient({
      conversationId,
      name: "Sam",
      externalUserId: "U0SAM",
    });
    const send = (text: string) =>
      tool(stage, "direct", ALEX, { to: "Sam", text });
    const pick = async () => {
      const rows = await db.actionApproval.findMany({
        where: { agentId: stage.agentId, action: CHOOSE, status: "pending" },
        select: { id: true },
      });
      expect(rows).toHaveLength(1);
      return (await approvals()).decideActionApproval({
        approvalId: rows[0]!.id,
        decision: "approve",
        choice: "agent",
        deciderUserId: ALEX,
      });
    };
    const blockedCards = () =>
      db.actionApproval.count({
        where: {
          agentId: stage.agentId,
          action: "channel.contact_blocked_send",
        },
      });
    const reach = async () =>
      (
        await db.agentReachGrant.findFirstOrThrow({
          where: { agentId: stage.agentId, externalRef: "U0SAM" },
          select: { state: true },
        })
      ).state;
    const samPref = () =>
      db.agentSendAsPreference.findFirst({
        where: { agentId: stage.agentId, userId: ALEX, recipientRef: "U0SAM" },
        select: { sendAs: true },
      });
    const resumes = () =>
      db.turn.findMany({
        where: { conversationId, source: "approval" },
        select: { message: true },
      });
    return {
      stage,
      send,
      pick,
      blockedCards,
      reach,
      samPref,
      resumes,
    };
  };
  const sentTo = (text: string) =>
    posts().filter(
      (c) => !c.form.get("blocks") && String(c.form.get("text")).includes(text),
    );

  it("pick agent on a blocked contact: Can talk with becomes Always allow (Contacts), pref stored, sent, no second card; next send skips the card", async () => {
    const t = await blockedSam("cs-blk-allow");
    expect(await t.send("enjoy the gym")).toMatchObject({
      result: { status: "needs_choice" },
    });
    expect(await t.pick()).toMatchObject({
      kind: "decided",
      status: "executed",
    });
    expect(sentTo("enjoy the gym")).toHaveLength(1);
    expect(await t.blockedCards()).toBe(0);
    expect(await t.reach()).toBe("approved");
    expect(await t.samPref()).toEqual({ sendAs: "agent" });
    const resumes = await t.resumes();
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.message).toMatch(/^Sent as Helper cs-blk-allow to Sam/);

    expect(await t.send("second")).toMatchObject({
      result: { status: "sent", remembered: true },
    });
    expect(sentTo("second")).toHaveLength(1);
  });

  it("set to Never in Contacts after the pick: the pick is forgotten and the next send asks again", async () => {
    const t = await blockedSam("cs-blk-never");
    await t.send("first");
    await t.pick();
    await db.agentReachGrant.updateMany({
      where: { agentId: t.stage.agentId, externalRef: "U0SAM" },
      data: { state: "blocked" },
    });
    expect(await t.send("second")).toMatchObject({
      result: { status: "needs_choice" },
    });
    expect(await t.samPref()).toBeNull();
    expect(sentTo("second")).toHaveLength(0);
  });

  it("Don't send on the question: nothing sent, nothing stored, the agent hears Not sent", async () => {
    const t = await blockedSam("cs-blk-dont");
    await t.send("nope");
    const [row] = await db.actionApproval.findMany({
      where: { agentId: t.stage.agentId, action: CHOOSE, status: "pending" },
      select: { id: true },
    });
    await (
      await approvals()
    ).decideActionApproval({
      approvalId: row!.id,
      decision: "reject",
      deciderUserId: ALEX,
    });
    expect(sentTo("nope")).toHaveLength(0);
    expect(await t.samPref()).toBeNull();
    expect(await t.reach()).toBe("blocked");
    const resumes = await t.resumes();
    expect(resumes.at(-1)?.message).toMatch(/^Not sent to Sam.*Don't send/);
  });

  it("a newer request supersedes the stale connect card; one connect card per person", async () => {
    const stage = await stageWithChannel("cs-stale");
    handlers["conversations.list"] = () => ({
      channels: [
        { id: "C0REPORTS", name: "weekly-reports", is_member: true },
        { id: "C0GENERAL", name: "general", is_member: true },
      ],
      response_metadata: { next_cursor: "" },
    });
    // An older "send as me" to #weekly-reports left a connect card.
    await tool(stage, "direct", ALEX, { sendAs: "you" });
    const pendingConnect = () =>
      db.actionApproval.findMany({
        where: {
          agentId: stage.agentId,
          action: "slack_access_request",
          status: "pending",
        },
        select: { id: true },
      });
    const [stale] = await pendingConnect();
    expect(stale).toBeDefined();
    // A second connect ask (another conversation) replaces it: one at most.
    await tool(stage, "direct", ALEX, {
      sendAs: "you",
      to: "#general",
      text: "other",
    });
    const now = await pendingConnect();
    expect(now).toHaveLength(1);
    expect(now[0]!.id).not.toBe(stale!.id);
    expect(
      (
        await db.actionApproval.findUniqueOrThrow({
          where: { id: stale!.id },
          select: { status: true },
        })
      ).status,
    ).toBe("expired");

    // Now a choose card for #general, picked as the agent: the stale
    // connect card for #general is withdrawn.
    await db.agentSendAsPreference.deleteMany({
      where: { agentId: stage.agentId },
    });
    await tool(stage, "direct", ALEX, { to: "#general", text: "other" });
    expect(await pendingConnect()).toHaveLength(0);
  });
});
