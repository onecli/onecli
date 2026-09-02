import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The SHARED Slack app's inbound HTTP arm (the org onboarding bot),
 * exercised END TO END through the mounted route
 * (`/v1/channels/slack/events`) with REAL `v0=` signatures - the closest we
 * can get to Slack itself without a live workspace. This is the trust
 * boundary the shared feature adds: an UNAUTHENTICATED route whose only
 * gate is the deployment signing secret.
 *
 * What must hold:
 * - a correctly signed DM earns the onboarding reply: an invitation minted
 *   for the speaker's Slack-verified email, delivered as a button whose URL
 *   carries that invitation's token;
 * - an already-onboarded member gets the dashboard button, no invitation;
 * - a WRONG-secret signature is a hint-free 401 (the negative control);
 * - an unknown team acks-and-drops (no probe surface);
 * - the challenge echo answers unverified but bounded.
 *
 * Plus the MARKETPLACE install path (the stateless arm Slack's own directory
 * button drives), which shares this file's fake Slack: a callback with no
 * state must park the code at the app instead of refusing it, and the
 * authenticated finish route must bind the workspace to the caller's org.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type SharedInstall =
  typeof import("../services/channels/providers/slack/shared-install-service");
type OAuthState = typeof import("../../src/lib/oauth-state");
type Providers = typeof import("../providers");

let db: Db;
let sharedInstall: SharedInstall;
let oauthState: OAuthState;
let initSelfUrl: Providers["initSelfUrl"];
let app: ReturnType<typeof import("../app").createApiApp>;

const P = "shw-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const ADMIN = `${P}admin`;
const MEMBER = `${P}member`;

/** The marketplace proofs get their OWN org: the suite's main org is bound to
 * TEAM in `beforeAll`, and one org may hold one Slack workspace — sharing it
 * would prove the conflict law rather than the install path. */
const MP_ORG = `${P}mporg`;
const MP_ADMIN = `${P}mpadmin`;
const MP_TEAM = "T-MARKETPLACE";

/** The signed-in caller the marketplace-finish proofs speak as. `let` so a
 * single mounted app can answer as different people (or as nobody). */
let currentSession: { id: string; email: string } | null = null;

const TEAM = "T-SHARED-WIRE";
const SIGNING_SECRET = "wire-signing-secret";
const SELF_URL = "https://api.sharedwire.test";

// ── The fake Slack Web API (oauth exchange + the picker's chat.postMessage) ──

let slackServer: Server;
let slackCalls: { method: string; form: URLSearchParams }[] = [];
const slackHandlers: Record<string, () => unknown> = {};

const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const method = (req.url ?? "/").slice(1);
        slackCalls.push({ method, form: new URLSearchParams(raw) });
        const handler = slackHandlers[method];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            handler
              ? handler()
              : { ok: false, error: `test_unscripted_${method}` },
          ),
        );
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

/** Wait until the fake has seen a call to `method` — the picker reply is
 * fired detached from the ack, so the assertion must poll briefly. */
const waitForSlackCall = async (method: string, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const call = slackCalls.find((c) => c.method === method);
    if (call) return call;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
};

// ── Signed requests, exactly as Slack sends them ────────────────────────────

const signedHeaders = (rawBody: string, secret: string) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
};

const postEvent = (body: unknown, secret = SIGNING_SECRET) => {
  const raw = JSON.stringify(body);
  return app.request("/v1/channels/slack/events", {
    method: "POST",
    headers: signedHeaders(raw, secret),
    body: raw,
  });
};

const eventEnvelope = (event: unknown, eventId: string, team = TEAM) => ({
  type: "event_callback",
  api_app_id: "A0SHAREDWIRE",
  team_id: team,
  event_id: eventId,
  event,
});

beforeAll(async () => {
  if (!PROOF_URL) return;

  const slackUrl = await startSlackFake();

  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  process.env.SLACK_API_BASE_URL = slackUrl;
  process.env.SLACK_SHARED_CLIENT_ID = "999.888";
  process.env.SLACK_SHARED_CLIENT_SECRET = "wire-client-secret";
  process.env.SLACK_SHARED_SIGNING_SECRET = SIGNING_SECRET;
  process.env.SLACK_SHARED_APP_ID = "A0SHAREDWIRE";
  // The four SLACK_SHARED_* credentials above are the arm's whole switch:
  // the suite proves webhooks, installs begun in Slack, and minting all
  // work on credentials alone.
  process.env.APP_URL = "https://app.sharedwire.test";

  ({ db } = await import("@onecli/db"));
  sharedInstall =
    await import("../services/channels/providers/slack/shared-install-service");
  oauthState = await import("../lib/oauth-state");
  const providers = await import("../providers");
  initSelfUrl = providers.initSelfUrl;
  initSelfUrl(SELF_URL);

  const { createApiApp } = await import("../app");
  // Sessionless: every request in this suite rides Slack-signature trust,
  // never a session — exactly the production posture of the inbound arm.
  app = createApiApp(
    { getSession: async () => currentSession },
    { selfUrl: SELF_URL },
  );

  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.invitation.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  // The finish-install route audits; the FK is RESTRICT, so the log rows
  // must go before their user does.
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.apiKey.deleteMany({ where: { userId: { startsWith: P } } });
  await db.organizationMember.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Shared Wire", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: ADMIN,
      email: `${ADMIN}@example.com`,
      externalAuthId: ADMIN,
      name: "Admin",
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: ADMIN,
      userEmail: `${ADMIN}@example.com`,
      role: "admin",
    },
  });

  // The marketplace org and its admin — no Slack anything yet, which is
  // exactly the posture of someone arriving from Slack's directory.
  await db.organization.create({
    data: { id: MP_ORG, name: MP_ORG, slug: MP_ORG },
  });
  await db.user.create({
    data: {
      id: MP_ADMIN,
      email: `${MP_ADMIN}@example.com`,
      externalAuthId: MP_ADMIN,
      name: "Marketplace Admin",
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: MP_ORG,
      userId: MP_ADMIN,
      userEmail: `${MP_ADMIN}@example.com`,
      role: "admin",
    },
  });

  // Install the shared app for the org (through the real completer).
  slackHandlers["oauth.v2.access"] = () => ({
    ok: true,
    access_token: "xoxb-wire-token",
    bot_user_id: "UWIREBOT",
    app_id: "A0SHAREDWIRE",
    team: { id: TEAM, name: "Wire Acme" },
    authed_user: {
      id: "UADMIN",
      access_token: "xoxp-wire-user-token",
      scope: "app_configurations:write,managed_apps:install",
    },
  });
  await sharedInstall.completeSharedInstallFromOAuth({
    state: oauthState.signOAuthState({
      provider: "slack",
      nonce: "n",
      kind: "shared-install",
      organizationId: ORG,
      actorUserId: ADMIN,
      issuedAt: Date.now(),
    }),
    code: "code",
    redirectUri: `${SELF_URL}/v1/channels/slack/oauth/callback`,
  });
  // An EXISTING member the "already onboarded" case speaks as.
  await db.user.create({
    data: {
      id: MEMBER,
      email: `${MEMBER}@example.com`,
      externalAuthId: MEMBER,
      name: "Member",
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: MEMBER,
      userEmail: `${MEMBER}@example.com`,
      role: "member",
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.invitation.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  // The finish-install route audits; the FK is RESTRICT, so the log rows
  // must go before their user does.
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.apiKey.deleteMany({ where: { userId: { startsWith: P } } });
  await db.organizationMember.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.$disconnect();
  slackServer?.close();
});

beforeEach(() => {
  slackCalls = [];
  currentSession = null;
});

describe.skipIf(!PROOF_URL)("the MARKETPLACE install path", () => {
  /** Slack's directory install lands on the same callback with NO state. */
  const callback = (query: string) =>
    app.request(`/v1/channels/slack/oauth/callback?${query}`, {
      method: "GET",
      redirect: "manual",
    });

  /** The finish route as the web calls it: a session plus an EXPLICIT
   * X-Organization-Id header — /slack/installed carries no org in its URL
   * for the client to derive a scope from, so the finish page sends the
   * confirmed org itself (`finishSharedInstall` sets the header; its
   * component test pins the org reaching the mutation). */
  // The two-step finish: INSPECT exchanges the code and names the workspace
  // (binding nothing); the confirmed CLAIM binds.
  const inspect = (code: string) =>
    app.request("/v1/org/channels/slack/finish-install/inspect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-organization-id": MP_ORG,
      },
      body: JSON.stringify({ code }),
    });
  const finish = (claim: string) =>
    app.request("/v1/org/channels/slack/finish-install", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-organization-id": MP_ORG,
      },
      body: JSON.stringify({ claim }),
    });

  it("a stateless callback parks the code at the app instead of refusing it", async () => {
    const res = await callback("code=mp-code-1");
    // The regression this path exists for: it used to answer 400 "This
    // install link is not valid", which is what a Slack reviewer would see.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.sharedwire.test/slack/installed?code=mp-code-1",
    );
  });

  it("the direct-install door 302s to a state-bearing authorize URL", async () => {
    // Slack validates this contract when the listing's Direct Install URL is
    // saved: GET → 302 → a fully-qualified slack.com/oauth/v2/authorize URL.
    const res = await app.request("/v1/channels/slack/direct-install", {
      method: "GET",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("999.888");
    // The state is OURS and anonymous — verifiable, the marketplace kind
    // (the Marketplace guideline wants state on every authorize URL we mint).
    const state = location.searchParams.get("state") ?? "";
    expect(sharedInstall.verifyMarketplaceInstallState(state)).toBe(true);
  });

  it("a callback carrying OUR marketplace state parks the code at the app", async () => {
    const direct = await app.request("/v1/channels/slack/direct-install", {
      method: "GET",
      redirect: "manual",
    });
    const state =
      new URL(direct.headers.get("location") ?? "").searchParams.get("state") ??
      "";
    const res = await callback(
      `code=mp-code-4&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.sharedwire.test/slack/installed?code=mp-code-4",
    );
    // Nothing was exchanged: the org is unknown until someone signs in.
    expect(slackCalls).toHaveLength(0);
  });

  it("a FORGED marketplace state is refused, not parked", async () => {
    const forged = Buffer.from(
      JSON.stringify({
        data: { kind: "marketplace-install", issuedAt: Date.now() },
        sig: "not-our-signature",
      }),
    ).toString("base64url");
    const res = await callback(
      `code=mp-code-5&state=${encodeURIComponent(forged)}`,
    );
    expect(res.status).toBe(400);
    expect(slackCalls).toHaveLength(0);
  });

  it("a code with no session is refused by the inspect route (401)", async () => {
    currentSession = null;
    const res = await inspect("mp-code-2");
    expect(res.status).toBe(401);
    // The negative control that matters: no exchange was attempted, so an
    // unauthenticated caller cannot spend a code it stole from a URL.
    expect(slackCalls).toHaveLength(0);
    // The confirm half is fenced identically.
    const confirm = await finish("any-claim");
    expect(confirm.status).toBe(401);
  });

  it("the signed-in admin's finish binds the workspace to THEIR org", async () => {
    slackHandlers["oauth.v2.access"] = () => ({
      ok: true,
      access_token: "xoxb-marketplace",
      bot_user_id: "UMPBOT",
      app_id: "A0SHAREDWIRE",
      team: { id: MP_TEAM, name: "Directory Acme" },
    });
    currentSession = { id: MP_ADMIN, email: `${MP_ADMIN}@example.com` };

    // Step 1 — INSPECT: the exchange runs, the workspace is NAMED, and
    // nothing is bound yet (the informed-consent half).
    const inspected = await inspect("mp-code-3");
    expect(inspected.status).toBe(200);
    const { team, claim } = (await inspected.json()) as {
      team: { externalId: string; name: string | null };
      claim: string;
    };
    expect(team).toEqual({ externalId: MP_TEAM, name: "Directory Acme" });
    expect(
      await db.channelInstallation.findUnique({
        where: {
          provider_externalId: { provider: "slack", externalId: MP_TEAM },
        },
      }),
    ).toBeNull();

    // Step 2 — the confirmed claim binds.
    const res = await finish(claim);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      organizationId: MP_ORG,
      teamId: MP_TEAM,
    });

    // The exchange used the SAME redirect_uri the consent did — Slack
    // rejects the pair otherwise, and nothing else in the suite proves it.
    const exchange = slackCalls.find((c) => c.method === "oauth.v2.access");
    expect(exchange?.form.get("redirect_uri")).toBe(
      `${SELF_URL}/v1/channels/slack/oauth/callback`,
    );
    expect(exchange?.form.get("code")).toBe("mp-code-3");

    const installed = await db.channelInstallation.findUnique({
      where: {
        provider_externalId: {
          provider: "slack",
          externalId: MP_TEAM,
        },
      },
      select: { botUserId: true, createdByUserId: true },
    });
    expect(installed?.botUserId).toBe("UMPBOT");
    // Attributed to the person who finished it: the onboarding bot mints
    // invitations in this user's name, so an unattributed install is inert.
    expect(installed?.createdByUserId).toBe(MP_ADMIN);

    await db.channelInstallation.deleteMany({
      where: { externalId: MP_TEAM },
    });
  });

  it("a FORGED claim is refused and binds nothing", async () => {
    currentSession = { id: MP_ADMIN, email: `${MP_ADMIN}@example.com` };
    const forged = Buffer.from(
      JSON.stringify({
        data: {
          provider: "slack",
          nonce: "n",
          kind: "finish-install-claim",
          organizationId: MP_ORG,
          actorUserId: MP_ADMIN,
          teamId: "TFORGED",
          sealed: "not-a-real-ciphertext",
          issuedAt: Date.now(),
        },
        sig: "0".repeat(64),
      }),
    ).toString("base64url");

    const res = await finish(forged);
    expect(res.status).toBe(422);
    expect(
      await db.channelInstallation.findUnique({
        where: {
          provider_externalId: { provider: "slack", externalId: "TFORGED" },
        },
      }),
    ).toBeNull();
  });

  it("an EXPIRED code earns the recovery sentence, not a bare invalid_code", async () => {
    // The marketplace arm parks the code across a human sign-UP, which
    // routinely outlives Slack's 10-minute code TTL — this is the flow's
    // most common failure, so its message must name the recovery.
    slackHandlers["oauth.v2.access"] = () => ({
      ok: false,
      error: "invalid_code",
    });
    currentSession = { id: MP_ADMIN, email: `${MP_ADMIN}@example.com` };

    const res = await inspect("mp-code-expired");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("expired");
    expect(body.error?.message).toContain("Start the install again");
  });
});

describe.skipIf(!PROOF_URL)(
  "the shared app's inbound wire (onboarding bot)",
  () => {
    const dm = (text: string, user = "USOMEONE") => ({
      type: "message",
      channel: "D-WIRE",
      channel_type: "im",
      user,
      text,
      ts: `${Date.now() / 1000}`,
    });

    it("a signed DM from a NEW person mints an invitation and posts the signup button", async () => {
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "D-WIRE",
        ts: "1.1",
      });
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: {
          id: "USOMEONE",
          profile: { email: "newcomer@example.com" },
        },
      });

      const res = await postEvent(
        eventEnvelope(dm("hi"), `wire-${Date.now()}-new`),
      );
      expect(res.status).toBe(200);

      const posted = await waitForSlackCall("chat.postMessage");
      expect(posted).toBeDefined();
      // The button URL carries the freshly minted invitation's token - the
      // whole onboarding promise in one assertion.
      const invitation = await db.invitation.findUnique({
        where: {
          organizationId_email: {
            organizationId: ORG,
            email: "newcomer@example.com",
          },
        },
        select: { token: true, status: true, role: true },
      });
      expect(invitation?.status).toBe("pending");
      expect(invitation?.role).toBe("member");
      const blocks = posted?.form.get("blocks") ?? "";
      expect(blocks).toContain(
        `/join?token=${encodeURIComponent(invitation?.token ?? "-none-")}`,
      );
      expect(posted?.form.get("channel")).toBe("D-WIRE");
    });

    it("an EXISTING org member gets the dashboard button and NO invitation", async () => {
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "D-WIRE",
        ts: "1.2",
      });
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: {
          id: "UMEMBER",
          profile: { email: `${MEMBER}@example.com` },
        },
      });

      const res = await postEvent(
        eventEnvelope(
          dm("hello again", "UMEMBER"),
          `wire-${Date.now()}-member`,
        ),
      );
      expect(res.status).toBe(200);

      const posted = await waitForSlackCall("chat.postMessage");
      expect(posted).toBeDefined();
      const blocks = posted?.form.get("blocks") ?? "";
      expect(blocks).toContain("https://app.sharedwire.test");
      expect(blocks).not.toContain("/join?token=");
      expect(
        await db.invitation.findUnique({
          where: {
            organizationId_email: {
              organizationId: ORG,
              email: `${MEMBER}@example.com`,
            },
          },
        }),
      ).toBeNull();
    });

    it("an UPPERCASE Slack profile email still matches the lowercase member — no forked invitation", async () => {
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "D-WIRE",
        ts: "1.3",
      });
      // Slack reports profile emails in whatever case the user typed; the
      // db.user row stores lowercase. Case drift must not fork one person
      // into an invitation beside their own membership.
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: {
          id: "UMEMBER",
          profile: { email: `${MEMBER}@example.com`.toUpperCase() },
        },
      });

      const res = await postEvent(
        eventEnvelope(dm("hello", "UMEMBER"), `wire-${Date.now()}-case`),
      );
      expect(res.status).toBe(200);

      const posted = await waitForSlackCall("chat.postMessage");
      expect(posted).toBeDefined();
      expect(posted?.form.get("text")).toContain("You're all set");
      expect(posted?.form.get("blocks") ?? "").not.toContain("/join?token=");
      expect(
        await db.invitation.count({
          where: {
            organizationId: ORG,
            email: {
              in: [
                `${MEMBER}@example.com`,
                `${MEMBER}@example.com`.toUpperCase(),
              ],
            },
          },
        }),
      ).toBe(0);
    });

    it("a LIVE pending invitation is reused as-is — the admin's token and role survive the DM", async () => {
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "D-WIRE",
        ts: "1.4",
      });
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: { id: "UPREWIRED", profile: { email: "prewired@example.com" } },
      });
      // An org admin already invited this person — deliberately as an ADMIN.
      // createInvitation's upsert would rotate the token (killing every
      // previously emailed link) and downgrade the role to "member": an
      // unauthenticated Slack event must never edit an admin's configuration.
      await db.invitation.create({
        data: {
          organizationId: ORG,
          email: "prewired@example.com",
          role: "admin",
          token: "prewired-original-token",
          invitedById: ADMIN,
          invitedByEmail: `${ADMIN}@example.com`,
          expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        },
      });

      const res = await postEvent(
        eventEnvelope(dm("hi", "UPREWIRED"), `wire-${Date.now()}-prewired`),
      );
      expect(res.status).toBe(200);

      const posted = await waitForSlackCall("chat.postMessage");
      expect(posted).toBeDefined();
      // The button carries the ORIGINAL token — no re-mint happened…
      expect(posted?.form.get("blocks") ?? "").toContain(
        "/join?token=prewired-original-token",
      );
      // …and the row kept both the token and the deliberately chosen role.
      const row = await db.invitation.findUniqueOrThrow({
        where: {
          organizationId_email: {
            organizationId: ORG,
            email: "prewired@example.com",
          },
        },
        select: { token: true, role: true, status: true },
      });
      expect(row.token).toBe("prewired-original-token");
      expect(row.role).toBe("admin");
      expect(row.status).toBe("pending");
    });

    it("a CANCELLED invitation blocks the mint — the DM cannot override an admin's revocation", async () => {
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "D-WIRE",
        ts: "1.5",
      });
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: { id: "UCANCELLED", profile: { email: "cancelled@example.com" } },
      });
      await db.invitation.create({
        data: {
          organizationId: ORG,
          email: "cancelled@example.com",
          role: "member",
          token: "cancelled-original-token",
          status: "cancelled",
          invitedById: ADMIN,
          invitedByEmail: `${ADMIN}@example.com`,
          expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        },
      });

      const res = await postEvent(
        eventEnvelope(
          dm("let me in", "UCANCELLED"),
          `wire-${Date.now()}-cancelled`,
        ),
      );
      expect(res.status).toBe(200);

      const posted = await waitForSlackCall("chat.postMessage");
      expect(posted).toBeDefined();
      // The ask-an-admin sentence, NO button — a re-mint would resurrect the
      // row (createInvitation's upsert flips cancelled back to pending).
      expect(posted?.form.get("text")).toBe(
        `Ask an admin of ${ORG} to invite you to OneCLI.`,
      );
      expect(posted?.form.get("blocks")).toBeNull();
      const row = await db.invitation.findUniqueOrThrow({
        where: {
          organizationId_email: {
            organizationId: ORG,
            email: "cancelled@example.com",
          },
        },
        select: { token: true, status: true },
      });
      expect(row.status).toBe("cancelled");
      expect(row.token).toBe("cancelled-original-token");
    });

    it("a workspace GUEST is fenced to ask-an-admin — no invitation auto-mints", async () => {
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "D-WIRE",
        ts: "1.6",
      });
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: {
          id: "UGUESTY",
          is_restricted: true,
          profile: { email: "guesty@example.com" },
        },
      });

      const res = await postEvent(
        eventEnvelope(dm("hi", "UGUESTY"), `wire-${Date.now()}-guest`),
      );
      expect(res.status).toBe(200);

      const posted = await waitForSlackCall("chat.postMessage");
      expect(posted).toBeDefined();
      expect(posted?.form.get("text")).toContain("Guest accounts");
      expect(posted?.form.get("blocks")).toBeNull();
      expect(
        await db.invitation.findUnique({
          where: {
            organizationId_email: {
              organizationId: ORG,
              email: "guesty@example.com",
            },
          },
        }),
      ).toBeNull();
    });

    it("a SUSPENDED installer cannot vouch — the DM earns ask-an-admin and mints nothing", async () => {
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "D-WIRE",
        ts: "1.7",
      });
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: {
          id: "UUNVOUCHED",
          profile: { email: "unvouched@example.com" },
        },
      });
      // Suspension must cut the installer's provisioning power — the same
      // law the install link obeys ("a departed admin's link dies with
      // them"). Their user row surviving is not enough.
      await db.organizationMember.update({
        where: {
          organizationId_userId: { organizationId: ORG, userId: ADMIN },
        },
        data: { status: "suspended" },
      });
      try {
        const res = await postEvent(
          eventEnvelope(dm("hi", "UUNVOUCHED"), `wire-${Date.now()}-unvouched`),
        );
        expect(res.status).toBe(200);

        const posted = await waitForSlackCall("chat.postMessage");
        expect(posted).toBeDefined();
        expect(posted?.form.get("text")).toContain(
          "no longer available to vouch",
        );
        expect(posted?.form.get("blocks")).toBeNull();
        expect(
          await db.invitation.findUnique({
            where: {
              organizationId_email: {
                organizationId: ORG,
                email: "unvouched@example.com",
              },
            },
          }),
        ).toBeNull();
      } finally {
        // ORDER-DEPENDENCE: the later mint/view/revoke cases need the
        // admin's membership live again.
        await db.organizationMember.update({
          where: {
            organizationId_userId: { organizationId: ORG, userId: ADMIN },
          },
          data: { status: "active" },
        });
      }
    });

    it("a seat-cap refusal (ServiceError) is relayed to the DM in its own words", async () => {
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "D-WIRE",
        ts: "1.8",
      });
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: { id: "USEATLESS", profile: { email: "seatless@example.com" } },
      });
      // The one ServiceError createInvitation raises rides the TeamHooks
      // seat gate (cloud's quota hook). Inject a refusing hook through the
      // REAL edition slot — the same seam ensureEditionDefaults() fills.
      const teamHooks = await import("../providers/hooks/team-hooks");
      const { ServiceError } = await import("../services/errors");
      teamHooks.initTeamHooks({
        beforeInviteMember: async () => {
          throw new ServiceError(
            "UNPROCESSABLE",
            "No seats are left on this plan.",
          );
        },
        afterMemberJoined: async () => {},
      });
      try {
        const res = await postEvent(
          eventEnvelope(dm("hi", "USEATLESS"), `wire-${Date.now()}-seatless`),
        );
        expect(res.status).toBe(200);

        const posted = await waitForSlackCall("chat.postMessage");
        expect(posted).toBeDefined();
        expect(posted?.form.get("text")).toBe(
          `No seats are left on this plan. Ask an admin of ${ORG} for an invite.`,
        );
        expect(posted?.form.get("blocks")).toBeNull();
        expect(
          await db.invitation.findUnique({
            where: {
              organizationId_email: {
                organizationId: ORG,
                email: "seatless@example.com",
              },
            },
          }),
        ).toBeNull();
      } finally {
        teamHooks.initTeamHooks(null);
      }
    });

    it("an INTERNAL mint failure posts the generic sentence — internals never reach Slack", async () => {
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "D-WIRE",
        ts: "1.85",
      });
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: { id: "UDBFAIL", profile: { email: "dbfail@example.com" } },
      });
      // A non-ServiceError failure (a DB error's internals) must be masked —
      // the distinctive string below must never reach a Slack workspace.
      const teamHooks = await import("../providers/hooks/team-hooks");
      teamHooks.initTeamHooks({
        beforeInviteMember: async () => {
          throw new Error("connection to db://secret failed");
        },
        afterMemberJoined: async () => {},
      });
      try {
        const res = await postEvent(
          eventEnvelope(dm("hi", "UDBFAIL"), `wire-${Date.now()}-dbfail`),
        );
        expect(res.status).toBe(200);

        const posted = await waitForSlackCall("chat.postMessage");
        expect(posted).toBeDefined();
        expect(posted?.form.get("text")).toBe(
          `I couldn't create your invitation. Ask an admin of ${ORG} for an invite.`,
        );
        expect(posted?.form.get("blocks")).toBeNull();
        // The internal string appears NOWHERE in the posted form.
        const wholeForm = [...(posted?.form.entries() ?? [])]
          .map(([key, value]) => `${key}=${value}`)
          .join("&");
        expect(wholeForm).not.toContain("db://secret");
      } finally {
        teamHooks.initTeamHooks(null);
      }
    });

    it("a REDELIVERED event (same event_id) posts exactly one reply", async () => {
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "D-WIRE",
        ts: "1.9",
      });
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: { id: "USOMEONE", profile: { email: "newcomer@example.com" } },
      });

      // Slack retries failed deliveries with the SAME event_id — the dedupe
      // map must eat the replay or every retry posts another invite button.
      const envelope = eventEnvelope(dm("hi again"), "wire-dedupe-1");
      expect((await postEvent(envelope)).status).toBe(200);
      expect((await postEvent(envelope)).status).toBe(200);
      await waitForSlackCall("chat.postMessage");
      await new Promise((r) => setTimeout(r, 150));
      expect(
        slackCalls.filter((c) => c.method === "chat.postMessage"),
      ).toHaveLength(1);
    });

    it("a channel MENTION gets a threaded DM-me nudge — never the email/token payload", async () => {
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "C-CHAN",
        ts: "2.1",
      });

      const res = await postEvent(
        eventEnvelope(
          {
            type: "app_mention",
            channel: "C-CHAN",
            user: "USOMEONE",
            text: "<@UWIREBOT> help",
            ts: "1724800000.000100",
          },
          `wire-${Date.now()}-mention`,
        ),
      );
      expect(res.status).toBe(200);

      const posted = await waitForSlackCall("chat.postMessage");
      expect(posted).toBeDefined();
      // Threaded on the mention itself, and PERSONAL DATA STAYS OUT OF
      // CHANNELS: no users.info round-trip (the email is never read), no
      // invitation minted, no /join token in the post — the full payload
      // exists only on the private DM door.
      expect(posted?.form.get("thread_ts")).toBe("1724800000.000100");
      expect(posted?.form.get("text")).toContain("direct message");
      expect(posted?.form.get("text")).not.toContain("/join?token=");
      expect(slackCalls.filter((c) => c.method === "users.info")).toHaveLength(
        0,
      );
    });

    it("the bot's own posts are ignored (echo guard - no infinite reply loop)", async () => {
      const res = await postEvent(
        eventEnvelope(
          dm("I am the bot", "UWIREBOT"),
          `wire-${Date.now()}-echo`,
        ),
      );
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 100));
      expect(slackCalls).toHaveLength(0);
    });

    it("refuses a WRONG-secret signature with a hint-free 401 (negative control)", async () => {
      const res = await postEvent(
        eventEnvelope(dm("hello"), `wire-${Date.now()}-forged`),
        "the-wrong-secret",
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
      // A refusal a retry can never fix — Slack is told not to burn its 3
      // retries on it (and not to count it toward the failure-rate cutoff).
      expect(res.headers.get("x-slack-no-retry")).toBe("1");
      expect(slackCalls).toHaveLength(0);
    });

    it("acks-and-drops an event from a workspace with no install (nothing to probe)", async () => {
      const res = await postEvent(
        eventEnvelope(dm("hello"), `wire-${Date.now()}-alien`, "T-NOBODY"),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      // Long enough for a stray detached reply to have surfaced.
      await new Promise((r) => setTimeout(r, 100));
      expect(slackCalls).toHaveLength(0);
    });

    it("echoes the URL-verification challenge (bounded, unverified by design)", async () => {
      const raw = JSON.stringify({
        type: "url_verification",
        challenge: "c".repeat(64),
      });
      // Deliberately UNSIGNED — Slack pings before any secret could be known.
      const res = await app.request("/v1/channels/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ challenge: "c".repeat(64) });
    });

    it("the install captured the admin's user token and reports mint capability", async () => {
      await expect(sharedInstall.sharedInstallCanMintApps(ORG)).resolves.toBe(
        true,
      );
    });

    it("app_home_opened (messages tab) sends the welcome ONCE per user", async () => {
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "D-HOME",
        ts: "9.1",
      });
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: { id: "UHOMEBODY", profile: { email: "homebody@example.com" } },
      });

      const open = (eventId: string) =>
        postEvent(
          eventEnvelope(
            { type: "app_home_opened", user: "UHOMEBODY", tab: "messages" },
            eventId,
          ),
        );

      const before = slackCalls.filter(
        (call) => call.method === "chat.postMessage",
      ).length;
      expect((await open(`wire-${Date.now()}-home1`)).status).toBe(200);
      const posted = await waitForSlackCall("chat.postMessage");
      expect(posted).toBeDefined();
      // The welcome goes to the opener's DM (user id as channel).
      const welcome = slackCalls
        .filter((call) => call.method === "chat.postMessage")
        .at(-1);
      expect(welcome?.form.get("channel")).toBe("UHOMEBODY");

      // A second open (fresh event id, same user) sends NOTHING more.
      expect((await open(`wire-${Date.now()}-home2`)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 150));
      expect(
        slackCalls.filter((call) => call.method === "chat.postMessage").length,
      ).toBe(before + 1);

      // A non-messages tab open sends nothing either.
      const res = await postEvent(
        eventEnvelope(
          { type: "app_home_opened", user: "USOMEONE-ELSE", tab: "home" },
          `wire-${Date.now()}-home3`,
        ),
      );
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 100));
      expect(
        slackCalls.filter((call) => call.method === "chat.postMessage").length,
      ).toBe(before + 1);
    });

    it("mint capability is still reported after the welcome traffic", async () => {
      await expect(sharedInstall.sharedInstallCanMintApps(ORG)).resolves.toBe(
        true,
      );
    });

    // The managed-apps HAPPY PATH: what production will do the day Slack
    // approves OneCLI as an app-manager app. Live testing is impossible
    // until then (apps.manifest.create answers invalid_manager_app for a
    // non-approved app), so the fake plays an approved Slack and this test
    // is the proof the whole chain works: shared install's user token →
    // apps.manifest.create → agent presence row, no config token anywhere.
    it("mints a dedicated agent app from the shared install's user token (no config token)", async () => {
      const agentChannels =
        await import("../services/channels/agent-channel-service");
      const agent = await db.agent.create({
        data: {
          workspaceId: WORKSPACE,
          name: "Wire Minted Agent",
          identifier: `${P}mint-agent`,
          accessToken: `aoc_${P}mint`,
          kind: "hosted",
          harness: "fake",
        },
        select: { id: true },
      });
      slackHandlers["apps.manifest.create"] = () => ({
        ok: true,
        app_id: "A0MINTED",
        credentials: {
          client_id: "77.88",
          client_secret: "minted-client-secret",
          signing_secret: "minted-signing-secret",
        },
        oauth_authorize_url:
          "https://slack.com/oauth/v2/authorize?client_id=77.88",
      });

      const created = await agentChannels.createPresence(
        WORKSPACE,
        agent.id,
        "slack",
        ADMIN,
      );
      expect(created.installUrl).toContain("client_id=77.88");
      expect(created.installUrl).toContain("state=");

      // The manifest call carried the USER token from the shared install,
      // not a config token (the org integration row has none to give).
      const mintCall = slackCalls.find(
        (c) => c.method === "apps.manifest.create",
      );
      expect(mintCall).toBeDefined();
      const integration = await db.channelIntegration.findUnique({
        where: {
          organizationId_provider: { organizationId: ORG, provider: "slack" },
        },
        select: { credentials: true },
      });
      expect(integration?.credentials).toBeNull();

      const presence = await db.agentChannel.findUnique({
        where: { agentId_provider: { agentId: agent.id, provider: "slack" } },
        select: { externalId: true, status: true },
      });
      expect(presence?.externalId).toBe("A0MINTED");
      expect(presence?.status).toBe("pending_setup");

      // Cleanup so the uninstall case below sees the expected counts.
      await db.agentChannel.deleteMany({ where: { agentId: agent.id } });
      await db.agent.delete({ where: { id: agent.id } });
    });

    it("the agent channels VIEW reports hasCredentials off the shared install (no pasted token)", async () => {
      // The UI keys every one-click flow off `hasCredentials`; the OR that
      // lights it up from a mint-capable shared install is what makes the
      // flagship UX work with a credentials-null integration row.
      const agentChannels =
        await import("../services/channels/agent-channel-service");
      const agent = await db.agent.create({
        data: {
          workspaceId: WORKSPACE,
          name: "View Pin Agent",
          identifier: `${P}view-agent`,
          accessToken: `aoc_${P}view`,
          kind: "hosted",
          harness: "fake",
        },
        select: { id: true },
      });
      const view = await agentChannels.getAgentChannels(WORKSPACE, agent.id);
      const slack = view.orgIntegrations.find((i) => i.provider === "slack");
      expect(slack?.hasCredentials).toBe(true);
      await db.agent.delete({ where: { id: agent.id } });
    });

    // The PRE-approval reality: SLACK_SHARED_APP_MANAGER_APPROVED may be
    // flipped (or Slack may revoke enrollment) while installs already carry
    // user tokens — every mint then refuses with invalid_manager_app, and
    // the code must mark the install so views stop advertising a capability
    // Slack denies, then fall through to the config-token path.
    it("invalid_manager_app marks the install managerAppRefused and falls back to the config token", async () => {
      const agentChannels =
        await import("../services/channels/agent-channel-service");
      const agent = await db.agent.create({
        data: {
          workspaceId: WORKSPACE,
          name: "Refused Mint Agent",
          identifier: `${P}refused-agent`,
          accessToken: `aoc_${P}refused`,
          kind: "hosted",
          harness: "fake",
        },
        select: { id: true },
      });
      slackHandlers["apps.manifest.create"] = () => ({
        ok: false,
        error: "invalid_manager_app",
      });

      // No pasted config token exists, so the fallback lands on the
      // "no automation token" refusal — proving the mint did NOT hard-fail
      // on Slack's refusal but took the fallback path.
      await expect(
        agentChannels.createPresence(WORKSPACE, agent.id, "slack", ADMIN),
      ).rejects.toThrow("no Slack automation token");

      // The refusal is STICKY on the install (a reinstall clears it) …
      const providers = await import("../providers");
      const row = await db.channelInstallation.findFirstOrThrow({
        where: { integration: { organizationId: ORG } },
        select: { credentials: true },
      });
      const creds = JSON.parse(
        await providers.getCrypto().decrypt(row.credentials),
      ) as { managerAppRefused?: boolean };
      expect(creds.managerAppRefused).toBe(true);
      // … and the capability stops being advertised.
      await expect(sharedInstall.sharedInstallCanMintApps(ORG)).resolves.toBe(
        false,
      );

      await db.agentChannel.deleteMany({ where: { agentId: agent.id } });
      await db.agent.delete({ where: { id: agent.id } });
    });

    // The strip is TARGETED at the stored installer id: another member who
    // once authorized the app getting deactivated must not kill the live
    // mint grant. Runs BEFORE the installer's own revocation below — the
    // pair discriminates "targeted" from "strip on any".
    it("tokens_revoked naming a DIFFERENT user leaves the installer's user token alone", async () => {
      const res = await postEvent(
        eventEnvelope(
          {
            type: "tokens_revoked",
            tokens: { oauth: ["USOMEBODY-ELSE"], bot: [] },
          },
          `wire-${Date.now()}-revoke-other`,
        ),
      );
      expect(res.status).toBe(200);
      const providers = await import("../providers");
      const row = await db.channelInstallation.findFirstOrThrow({
        where: { provider: "slack", externalId: TEAM },
        select: { credentials: true },
      });
      const creds = JSON.parse(
        await providers.getCrypto().decrypt(row.credentials),
      ) as { userToken?: string; installerSlackUserId?: string };
      // The install recorded WHOSE grant the user token is…
      expect(creds.installerSlackUserId).toBe("UADMIN");
      // …and a stranger's revocation left it in place.
      expect(creds.userToken).toBe("xoxp-wire-user-token");
    });

    // Slack's tokens_revoked can be PARTIAL: only the installing admin's
    // USER token dying (deactivated admin, trimmed grant) must not delete a
    // live bot install — it just loses the mint capability.
    it("tokens_revoked naming only USER tokens keeps the install and strips the user token", async () => {
      const res = await postEvent(
        eventEnvelope(
          { type: "tokens_revoked", tokens: { oauth: ["UADMIN"], bot: [] } },
          `wire-${Date.now()}-revoke-user`,
        ),
      );
      expect(res.status).toBe(200);
      // The install survives — the bot token is untouched…
      const providers = await import("../providers");
      const row = await db.channelInstallation.findFirstOrThrow({
        where: { provider: "slack", externalId: TEAM },
        select: { credentials: true },
      });
      // …but the dead user token is gone from the stored credential (the
      // capability already read false via the sticky mark above — the shape
      // assertion is what discriminates the strip).
      const creds = JSON.parse(
        await providers.getCrypto().decrypt(row.credentials),
      ) as { botToken?: string; userToken?: string };
      expect(creds.botToken).toBeDefined();
      expect(creds.userToken).toBeUndefined();
    });

    // LAST on purpose: these delete the install row the earlier cases need.
    it("app_uninstalled deletes the install row (lifecycle hygiene)", async () => {
      const before = await db.channelInstallation.count({
        where: { provider: "slack", externalId: TEAM },
      });
      expect(before).toBe(1);
      const res = await postEvent(
        eventEnvelope(
          { type: "app_uninstalled" },
          `wire-${Date.now()}-uninstall`,
        ),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const after = await db.channelInstallation.count({
        where: { provider: "slack", externalId: TEAM },
      });
      expect(after).toBe(0);
      // And a follow-up DM is now ack-and-drop, not a reply.
      await postEvent(eventEnvelope(dm("hello?"), `wire-${Date.now()}-after`));
      await new Promise((r) => setTimeout(r, 100));
      expect(slackCalls).toHaveLength(0);
    });

    it("tokens_revoked naming the BOT token removes the install like an uninstall", async () => {
      // Re-install through the real completer, with a fresh exchange script.
      slackHandlers["oauth.v2.access"] = () => ({
        ok: true,
        access_token: "xoxb-wire-token-2",
        bot_user_id: "UWIREBOT",
        app_id: "A0SHAREDWIRE",
        team: { id: TEAM, name: "Wire Acme" },
      });
      await sharedInstall.completeSharedInstallFromOAuth({
        state: oauthState.signOAuthState({
          provider: "slack",
          nonce: "n2",
          kind: "shared-install",
          organizationId: ORG,
          actorUserId: ADMIN,
          issuedAt: Date.now(),
        }),
        code: "code-2",
        redirectUri: `${SELF_URL}/v1/channels/slack/oauth/callback`,
      });

      const res = await postEvent(
        eventEnvelope(
          {
            type: "tokens_revoked",
            tokens: { oauth: [], bot: ["UWIREBOT"] },
          },
          `wire-${Date.now()}-revoke-bot`,
        ),
      );
      expect(res.status).toBe(200);
      expect(
        await db.channelInstallation.count({
          where: { provider: "slack", externalId: TEAM },
        }),
      ).toBe(0);
    });

    // A workspace's first DM can land while "not installed" is still cached
    // (the workspace probed the bot before OAuth completed). The install's
    // cache invalidation must beat the negative TTL — asserted IMMEDIATELY,
    // well inside the seconds a stale negative would otherwise live. Its own
    // org and team, so it can run after the uninstall cases above.
    it("completing an install evicts the cached negative — the first DM answers at once", async () => {
      const NEG_ORG = `${P}negorg`;
      const NEG_ADMIN = `${P}negadmin`;
      const NEG_TEAM = "T-NEGCACHE";
      await db.organization.create({
        data: { id: NEG_ORG, name: NEG_ORG, slug: NEG_ORG },
      });
      await db.user.create({
        data: {
          id: NEG_ADMIN,
          email: `${NEG_ADMIN}@example.com`,
          externalAuthId: NEG_ADMIN,
          name: "Neg Admin",
        },
      });
      await db.organizationMember.create({
        data: {
          organizationId: NEG_ORG,
          userId: NEG_ADMIN,
          userEmail: `${NEG_ADMIN}@example.com`,
          role: "admin",
        },
      });

      // PLANT the negative: a signed DM from a team with no install row
      // acks 200 and drops — and caches "not installed" for this team.
      const planted = await postEvent(
        eventEnvelope(
          dm("anyone home?"),
          `wire-${Date.now()}-neg-plant`,
          NEG_TEAM,
        ),
      );
      expect(planted.status).toBe(200);
      expect(await planted.json()).toEqual({ ok: true });

      // Complete a REAL install for that exact team.
      slackHandlers["oauth.v2.access"] = () => ({
        ok: true,
        access_token: "xoxb-neg-token",
        bot_user_id: "UNEGBOT",
        app_id: "A0SHAREDWIRE",
        team: { id: NEG_TEAM, name: "Negative Acme" },
      });
      await sharedInstall.completeSharedInstallFromOAuth({
        state: oauthState.signOAuthState({
          provider: "slack",
          nonce: "n-neg",
          kind: "shared-install",
          organizationId: NEG_ORG,
          actorUserId: NEG_ADMIN,
          issuedAt: Date.now(),
        }),
        code: "code-neg",
        redirectUri: `${SELF_URL}/v1/channels/slack/oauth/callback`,
      });

      // The very next DM must answer — no sleep: the invalidation, not the
      // negative TTL expiring, is what lets it through.
      slackHandlers["chat.postMessage"] = () => ({
        ok: true,
        channel: "D-WIRE",
        ts: "3.1",
      });
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: { id: "USOMEONE", profile: { email: "negcomer@example.com" } },
      });
      const res = await postEvent(
        eventEnvelope(dm("hi"), `wire-${Date.now()}-neg-dm`, NEG_TEAM),
      );
      expect(res.status).toBe(200);
      const posted = await waitForSlackCall("chat.postMessage");
      expect(posted).toBeDefined();
      expect(posted?.form.get("blocks") ?? "").toContain("/join?token=");
    });
  },
);

describe.skipIf(!PROOF_URL)("the DEDICATED arm's lifecycle fence", () => {
  it("a pending_setup shell's signed events are refused — the detach promise holds even when the remote uninstall failed", async () => {
    const providers = await import("../providers");
    const agent = await db.agent.create({
      data: {
        workspaceId: WORKSPACE,
        name: "Fence Agent",
        identifier: `${P}fence-agent`,
        accessToken: `aoc_${P}fence`,
        kind: "hosted",
        harness: "fake",
      },
      select: { id: true },
    });
    const integration = await db.channelIntegration.findUniqueOrThrow({
      where: {
        organizationId_provider: { organizationId: ORG, provider: "slack" },
      },
      select: { id: true },
    });
    const secret = "fence-signing-secret";
    const presence = await db.agentChannel.create({
      data: {
        agentId: agent.id,
        integrationId: integration.id,
        provider: "slack",
        externalId: "A0FENCE",
        transport: "events",
        // A detached shell keeps its credentials so a resume can rebuild the
        // consent URL — exactly why the status fence, not credential
        // presence, must gate inbound processing.
        credentials: await providers
          .getCrypto()
          .encrypt(
            JSON.stringify({ signingSecret: secret, botToken: "xoxb-fence" }),
          ),
        status: "pending_setup",
      },
      select: { id: true },
    });

    // An ignorable-but-verifiable event (bot-authored: dispatch drops it as
    // an echo, so the 200 case has no side effects to clean up).
    const envelopeFor = (eventId: string) =>
      JSON.stringify({
        type: "event_callback",
        api_app_id: "A0FENCE",
        team_id: TEAM,
        event_id: eventId,
        event: {
          type: "message",
          channel: "D-FENCE",
          channel_type: "im",
          bot_id: "B0FENCE",
          text: "echo",
          ts: "1.0",
        },
      });

    const shellRaw = envelopeFor(`wire-${Date.now()}-fence-shell`);
    const refused = await app.request("/v1/channels/slack/events", {
      method: "POST",
      headers: signedHeaders(shellRaw, secret),
      body: shellRaw,
    });
    // Correctly signed, yet refused: the shell must not process events.
    expect(refused.status).toBe(401);

    // Re-activation takes effect immediately (refused rows are never cached).
    await db.agentChannel.update({
      where: { id: presence.id },
      data: { status: "active" },
      select: { id: true },
    });
    const activeRaw = envelopeFor(`wire-${Date.now()}-fence-active`);
    const accepted = await app.request("/v1/channels/slack/events", {
      method: "POST",
      headers: signedHeaders(activeRaw, secret),
      body: activeRaw,
    });
    expect(accepted.status).toBe(200);

    await db.agentChannel.delete({ where: { id: presence.id } });
    await db.agent.delete({ where: { id: agent.id } });
  });
});
