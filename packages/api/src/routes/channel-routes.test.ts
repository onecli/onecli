import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "../providers";

/**
 * The channel surfaces' HTTP contract (step 6): org-channels' role gate in
 * BOTH CAPS.rbac arms, the `cha_` token family fenced in both directions,
 * the adapter wire's status codes, and the Slack inbound trust model
 * (challenge echo, signature 401s, OAuth callback redirects). Services are
 * mocked (the conversations.test.ts pattern); the DB laws live in
 * services/channels/channels.pg.test.ts.
 *
 * `CAPS` is resolved at module load, and org-channels bakes its guard at
 * router construction — so lib/env is mocked with a MUTABLE `rbac` getter
 * and two apps are built, one per arm.
 */

const ORG_ID = "org-1";
const CHA_TOKEN = "cha_registered-adapter-token";
const SIGNING_SECRET = "route-suite-signing-secret";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  // The dashboard origin the OAuth callback redirects home to.
  process.env.APP_URL = "https://app.example.test";
});

const caps = vi.hoisted(() => ({ rbac: false }));
const store = vi.hoisted(() => ({ role: "owner" as OrgRole }));

vi.mock("../lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/env")>();
  return {
    ...actual,
    CAPS: {
      ...actual.CAPS,
      get rbac() {
        return caps.rbac;
      },
    },
  };
});

const services = vi.hoisted(() => ({
  // channel-integration-service
  getIntegrationView: vi.fn(),
  listUserLinks: vi.fn(),
  connectIntegration: vi.fn(),
  disconnectIntegration: vi.fn(),
  addUserLink: vi.fn(),
  removeUserLink: vi.fn(),
  withFreshIntegrationCredentials: vi.fn(),
  rotateStaleIntegrations: vi.fn(),
  // agent-channel-service
  getAgentChannels: vi.fn(),
  getSetupMaterial: vi.fn(),
  createPresence: vi.fn(),
  completePresence: vi.fn(),
  detachPresence: vi.fn(),
  completePresenceFromOAuth: vi.fn(),
  // channel-adapter-service
  registerAdapter: vi.fn(),
  heartbeatAdapter: vi.fn(),
  adapterLiveness: vi.fn(),
  getAdapterConfig: vi.fn(),
  getAdapterWork: vi.fn(),
  advanceMirrorCursor: vi.fn(),
  reportApprovalAuth: vi.fn(),
  claimApprovalPrompt: vi.fn(),
  recordApprovalPromptMessage: vi.fn(),
  settleApprovalPrompt: vi.fn(),
  listUnsettledPrompts: vi.fn(),
  requireLinkedConversation: vi.fn(),
  // channel-approval-service + slack dispatch
  decideApprovalFromChannel: vi.fn(),
  dispatchSlackEvent: vi.fn(),
  // turn-receipt-service
  clearTurnReceipts: vi.fn(),
}));

const dbSpies = vi.hoisted(() => ({
  presenceByAppId: vi.fn(),
  auditCreate: vi.fn(async () => ({})),
}));

vi.mock("@onecli/db", () => {
  const empty = {
    findFirst: async () => null,
    findUnique: async () => null,
    findMany: async () => [],
    count: async () => 0,
    create: async () => ({}),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
  };
  const overrides: Record<string, unknown> = {
    user: {
      ...empty,
      // Serves both session lookups: by externalAuthId (login) and by id
      // (workspace resolution reads the memberships).
      findUnique: async () => ({
        id: "user-1",
        email: "member@example.com",
        organizationMemberships: [{ organizationId: ORG_ID }],
      }),
    },
    organizationMember: {
      ...empty,
      findFirst: async () => ({ organizationId: ORG_ID }),
      findUnique: async () => ({
        organizationId: ORG_ID,
        userId: "user-1",
        role: store.role,
      }),
    },
    workspace: {
      ...empty,
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === "p1" ? { id: "p1", organizationId: ORG_ID } : null,
      findUnique: async ({ where }: { where: { id?: string } }) =>
        where.id === "p1" ? { id: "p1", organizationId: ORG_ID } : null,
    },
    channelAdapter: {
      ...empty,
      findUnique: async ({ where }: { where: { token?: string } }) =>
        where.token === CHA_TOKEN
          ? { id: "ad-1", name: "adapter", kind: "instance" }
          : null,
    },
    agentChannel: {
      ...empty,
      // Two distinct findUnique callers now, discriminated by the `where`:
      //  - inbound presence-by-app-id: the hardened verifyInbound resolves the
      //    presence by the `(provider, externalId)` COMPOSITE UNIQUE (it used
      //    to be a findFirst on an index). Routed to the spy so the
      //    challenge-echo test can still assert it is never consulted.
      //  - adapter ingest: the identity lookup by row id.
      findUnique: async ({
        where,
      }: {
        where: {
          id?: string;
          provider_externalId?: { provider: string; externalId: string };
        };
      }) =>
        where.provider_externalId
          ? dbSpies.presenceByAppId({ where })
          : where.id === "pr-1"
            ? { identityRef: "UBOT", provider: "slack" }
            : null,
    },
    auditLog: { ...empty, create: dbSpies.auditCreate },
  };
  return {
    Prisma: {},
    db: new Proxy(
      {},
      { get: (_target, name: string) => overrides[name] ?? empty },
    ),
  };
});

vi.mock("../services/channels/channel-integration-service", () => ({
  getIntegrationView: services.getIntegrationView,
  listUserLinks: services.listUserLinks,
  connectIntegration: services.connectIntegration,
  disconnectIntegration: services.disconnectIntegration,
  addUserLink: services.addUserLink,
  removeUserLink: services.removeUserLink,
  withFreshIntegrationCredentials: services.withFreshIntegrationCredentials,
  rotateStaleIntegrations: services.rotateStaleIntegrations,
}));

vi.mock("../services/channels/agent-channel-service", () => ({
  getAgentChannels: services.getAgentChannels,
  getSetupMaterial: services.getSetupMaterial,
  createPresence: services.createPresence,
  completePresence: services.completePresence,
  detachPresence: services.detachPresence,
  completePresenceFromOAuth: services.completePresenceFromOAuth,
}));

vi.mock("../services/channels/channel-adapter-service", () => ({
  registerAdapter: services.registerAdapter,
  heartbeatAdapter: services.heartbeatAdapter,
  adapterLiveness: services.adapterLiveness,
  getAdapterConfig: services.getAdapterConfig,
  getAdapterWork: services.getAdapterWork,
  advanceMirrorCursor: services.advanceMirrorCursor,
  reportApprovalAuth: services.reportApprovalAuth,
  claimApprovalPrompt: services.claimApprovalPrompt,
  recordApprovalPromptMessage: services.recordApprovalPromptMessage,
  settleApprovalPrompt: services.settleApprovalPrompt,
  listUnsettledPrompts: services.listUnsettledPrompts,
  requireLinkedConversation: services.requireLinkedConversation,
}));

vi.mock("../services/channels/channel-approval-service", () => ({
  decideApprovalFromChannel: services.decideApprovalFromChannel,
}));

vi.mock("../services/channels/providers/slack/dispatch", () => ({
  dispatchSlackEvent: services.dispatchSlackEvent,
}));

vi.mock("../services/channels/turn-receipt-service", () => ({
  attachTurnReceipt: vi.fn(),
  moveTurnReceipt: vi.fn(),
  clearTurnReceipts: services.clearTurnReceipts,
}));

const { createApiApp } = await import("../app");
const { getCrypto } = await import("../providers");
const { ServiceError } = await import("../services/errors");
const { SlackApiError } =
  await import("../services/channels/providers/slack/slack-api");

/**
 * An ambient local session (onprem local-auth shape): present only when the
 * request carries NO bearer of its own — a real deployment's session cookie
 * never authenticates an Authorization header it does not understand, and
 * modelling that is exactly what lets the family-fence tests below prove a
 * `cha_` token is NOT a session.
 */
const session = {
  getSession: async (request: Request) =>
    request.headers.get("authorization")
      ? null
      : { id: "ext-user-1", email: "member@example.com" },
};
const roleResolver = { getUserRole: async () => store.role };

// Two apps, one per CAPS.rbac arm: the org-channels guard is baked at router
// construction, so each arm needs its own instance.
caps.rbac = true;
const appRbacOn = createApiApp(session, {
  roleResolver,
  selfUrl: "https://api.example.test",
});
caps.rbac = false;
const appRbacOff = createApiApp(session, {
  selfUrl: "https://api.example.test",
});

/** Presence credentials as the inbound routes store them: encrypted JSON. */
const ENCRYPTED_PRESENCE_CREDS = await getCrypto().encrypt(
  JSON.stringify({ signingSecret: SIGNING_SECRET, botToken: "xoxb-route" }),
);

const ORG_HEADERS = { "x-organization-id": ORG_ID };
const WORKSPACE_HEADERS = { "x-workspace-id": "p1" };
const CHA_AUTH = { authorization: `Bearer ${CHA_TOKEN}` };

/** Slack's own signing scheme over the EXACT raw body. `atSeconds` overrides
 * the timestamp so a test can forge a correctly-signed but STALE request. */
const slackSigned = (
  rawBody: string,
  secret = SIGNING_SECRET,
  atSeconds = Math.floor(Date.now() / 1000),
) => {
  const ts = String(atSeconds);
  return {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": `v0=${createHmac("sha256", secret)
      .update(`v0:${ts}:${rawBody}`)
      .digest("hex")}`,
  };
};

beforeEach(() => {
  for (const fn of Object.values(services)) fn.mockReset();
  dbSpies.presenceByAppId.mockReset();
  dbSpies.auditCreate.mockClear();
  caps.rbac = false;
  store.role = "owner";

  services.getIntegrationView.mockResolvedValue([]);
  services.listUserLinks.mockResolvedValue([]);
  services.adapterLiveness.mockResolvedValue({
    online: false,
    lastSeenAt: null,
  });
  services.connectIntegration.mockResolvedValue({
    provider: "slack",
    tenant: { externalId: "T111", name: null },
  });
  services.addUserLink.mockResolvedValue({ id: "lnk-1" });
  services.getAgentChannels.mockResolvedValue({
    presences: [],
    posture: { transport: "socket", available: ["socket"] },
    orgIntegrations: [],
    adapter: { online: false, lastSeenAt: null },
  });
  services.createPresence.mockResolvedValue({
    presenceId: "pr-1",
    transport: "events",
    installUrl: "https://slack.com/oauth/v2/authorize?x=1",
    settingsUrl: "https://api.slack.com/apps/A100/general",
  });
  services.registerAdapter.mockResolvedValue({ ok: true, adapterId: "ad-1" });
  // getAdapterConfig now returns a DISCRIMINATED UNION and does the etag
  // compare itself: a matching If-None-Match yields { notModified: true }
  // (and never decrypts). The route branches on `.notModified`.
  services.getAdapterConfig.mockImplementation(
    async (_caller: unknown, ifNoneMatch?: string) =>
      ifNoneMatch === "etag-1"
        ? { notModified: true, etag: "etag-1" }
        : { notModified: false, presences: [], etag: "etag-1" },
  );
  services.getAdapterWork.mockResolvedValue({ finished: [] });
  services.advanceMirrorCursor.mockResolvedValue(true);
  services.requireLinkedConversation.mockResolvedValue({ id: "lnk-1" });
  services.decideApprovalFromChannel.mockResolvedValue({
    kind: "decided",
    decidedByName: "Morgan",
  });
  services.dispatchSlackEvent.mockResolvedValue({
    kind: "ignored",
    reason: "test-default",
  });
  // Resolve by the (provider, externalId) composite unique now. A100 keeps its
  // "pr-1" id (the dispatch assertion pins it); A-CACHE and A-STALE are
  // never-cached ids the signing-secret-cache and timestamp-precheck tests use.
  dbSpies.presenceByAppId.mockImplementation(
    async ({
      where,
    }: {
      where: { provider_externalId?: { externalId?: string } };
    }) => {
      const appId = where.provider_externalId?.externalId;
      if (appId === "A100")
        return {
          id: "pr-1",
          status: "active",
          identityRef: "UBOT",
          credentials: ENCRYPTED_PRESENCE_CREDS,
          agent: { id: "ag-1", imageKey: null },
        };
      if (appId === "A-CACHE" || appId === "A-STALE")
        return {
          id: `pr-${appId}`,
          status: "active",
          identityRef: "UBOT",
          credentials: ENCRYPTED_PRESENCE_CREDS,
          agent: { id: "ag-1", imageKey: null },
        };
      // The avatar arm: a presence whose agent HAS an image key, so the
      // events-side refusal posts must carry the derived icon_url.
      if (appId === "A-ICON")
        return {
          id: "pr-icon",
          status: "active",
          identityRef: "UBOT",
          credentials: ENCRYPTED_PRESENCE_CREDS,
          agent: { id: "ag-icon", imageKey: "k".repeat(32) },
        };
      return null;
    },
  );
});

// ── org-channels: the role gate, both CAPS.rbac arms ────────────────────────

describe("GET /v1/org/channels where roles are ENFORCED (CAPS.rbac on)", () => {
  beforeEach(() => {
    caps.rbac = true;
  });

  it("REFUSES a plain member with 403, before any read", async () => {
    // MUTATION-TESTED (one half of the guard ternary): collapse
    // `CAPS.rbac ? auth(admin) : auth()` to the permissive arm and this
    // member reads the whole org's workspace bindings and user links.
    store.role = "member";

    const res = await appRbacOn.request("/v1/org/channels", {
      headers: ORG_HEADERS,
    });

    expect(res.status).toBe(403);
    expect(services.getIntegrationView).not.toHaveBeenCalled();
  });

  it("lets an admin read the settings payload", async () => {
    store.role = "admin";

    const res = await appRbacOn.request("/v1/org/channels", {
      headers: ORG_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      integrations: [],
      userLinks: [],
      adapter: { online: false, lastSeenAt: null },
      sharedApp: {
        available: false,
        canMintAgentApps: false,
        installMintsAgentApps: false,
        installation: null,
      },
    });
  });

  it("admin-gates the write routes too", async () => {
    store.role = "member";
    const res = await appRbacOn.request("/v1/org/channels/slack/credentials", {
      method: "PUT",
      headers: { ...ORG_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ credential: "xoxe-paste" }),
    });
    expect(res.status).toBe(403);
    expect(services.connectIntegration).not.toHaveBeenCalled();
  });
});

describe("GET /v1/org/channels where roles are NOT enforced (CAPS.rbac off)", () => {
  it("a plain member passes — there is no role resolver to consult", async () => {
    // MUTATION-TESTED (the other half of the ternary): make the guard
    // unconditionally `auth({ role: "admin" })` and every onprem deployment
    // — where no role resolver exists — answers 403 to everyone including
    // the owner. This member-passes test is what catches that.
    store.role = "member";

    const res = await appRbacOff.request("/v1/org/channels", {
      headers: ORG_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(services.getIntegrationView).toHaveBeenCalledWith(ORG_ID);
  });

  it("still requires SOME authentication", async () => {
    const res = await appRbacOff.request("/v1/org/channels", {
      headers: { ...ORG_HEADERS, authorization: "Bearer cha_not-a-session" },
    });
    expect(res.status).toBe(401);
  });

  it("connects a credential and audits it", async () => {
    const res = await appRbacOff.request("/v1/org/channels/slack/credentials", {
      method: "PUT",
      headers: { ...ORG_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ credential: "xoxe-paste" }),
    });

    expect(res.status).toBe(200);
    expect(services.connectIntegration).toHaveBeenCalledWith(
      ORG_ID,
      "slack",
      "xoxe-paste",
      "user-1",
    );
    expect(dbSpies.auditCreate).toHaveBeenCalled();
  });

  it("rejects a bad connect body with 422", async () => {
    const res = await appRbacOff.request("/v1/org/channels/slack/credentials", {
      method: "PUT",
      headers: { ...ORG_HEADERS, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(422);
    expect(services.connectIntegration).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown provider", async () => {
    const res = await appRbacOff.request(
      "/v1/org/channels/carrier-pigeon/credentials",
      {
        method: "PUT",
        headers: { ...ORG_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ credential: "xoxe-paste" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("disconnects with 204", async () => {
    const res = await appRbacOff.request("/v1/org/channels/slack", {
      method: "DELETE",
      headers: ORG_HEADERS,
    });
    expect(res.status).toBe(204);
    expect(services.disconnectIntegration).toHaveBeenCalledWith(
      ORG_ID,
      "slack",
    );
  });

  it("adds and removes user links", async () => {
    const add = await appRbacOff.request("/v1/org/channels/slack/user-links", {
      method: "POST",
      headers: { ...ORG_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ externalUserId: "U1", userId: "user-2" }),
    });
    expect(add.status).toBe(201);
    expect(services.addUserLink).toHaveBeenCalledWith(ORG_ID, "slack", {
      externalUserId: "U1",
      userId: "user-2",
    });

    const remove = await appRbacOff.request(
      "/v1/org/channels/slack/user-links/lnk-1",
      { method: "DELETE", headers: ORG_HEADERS },
    );
    expect(remove.status).toBe(204);
    expect(services.removeUserLink).toHaveBeenCalledWith(ORG_ID, "lnk-1");
  });

  it("rejects a malformed user-link body with 422", async () => {
    const res = await appRbacOff.request("/v1/org/channels/slack/user-links", {
      method: "POST",
      headers: { ...ORG_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ externalUserId: "U1" }),
    });
    expect(res.status).toBe(422);
    expect(services.addUserLink).not.toHaveBeenCalled();
  });
});

// ── The token families, fenced in BOTH directions ───────────────────────────

describe("token families do not cross", () => {
  it("a cha_ token is NOT a credential on the user surface (/v1/agents/*)", async () => {
    const res = await appRbacOff.request("/v1/agents/ag-1/channels", {
      headers: { ...CHA_AUTH, ...WORKSPACE_HEADERS },
    });
    expect(res.status).toBe(401);
    expect(services.getAgentChannels).not.toHaveBeenCalled();
  });

  it("a cha_ token is not a credential on the org surface either", async () => {
    const res = await appRbacOff.request("/v1/org/channels", {
      headers: { ...CHA_AUTH, ...ORG_HEADERS },
    });
    expect(res.status).toBe(401);
    expect(services.getIntegrationView).not.toHaveBeenCalled();
  });

  it("an oc_ key is NOT a credential on the adapter surface", async () => {
    const res = await appRbacOff.request("/v1/channel-adapter/heartbeat", {
      method: "POST",
      headers: { authorization: "Bearer oc_org_some-user-key" },
    });
    expect(res.status).toBe(401);
    expect(services.heartbeatAdapter).not.toHaveBeenCalled();
  });

  it("an ambient session is not one either — the adapter surface wants a bearer", async () => {
    const res = await appRbacOff.request("/v1/channel-adapter/config", {
      headers: ORG_HEADERS, // would authenticate the user surface
    });
    expect(res.status).toBe(401);
    expect(services.getAdapterConfig).not.toHaveBeenCalled();
  });

  it("an UNKNOWN cha_ token is refused on the authenticated adapter routes", async () => {
    const res = await appRbacOff.request("/v1/channel-adapter/config", {
      headers: { authorization: "Bearer cha_never-registered" },
    });
    expect(res.status).toBe(401);
    expect(services.getAdapterConfig).not.toHaveBeenCalled();
  });

  it("the adapter's transcript reads reject every non-cha_ credential", async () => {
    for (const headers of [
      { authorization: "Bearer oc_org_some-user-key" },
      { authorization: "Bearer rnr_a-runner-token" },
      ORG_HEADERS,
    ]) {
      const events = await appRbacOff.request(
        "/v1/channel-adapter/conversations/cv-1/events",
        { headers },
      );
      expect(events.status).toBe(401);
    }
    expect(services.requireLinkedConversation).not.toHaveBeenCalled();
  });
});

describe("POST /v1/channel-adapter/register", () => {
  it("refuses a non-cha_ bearer BEFORE consulting the service", async () => {
    const res = await appRbacOff.request("/v1/channel-adapter/register", {
      method: "POST",
      headers: {
        authorization: "Bearer oc_org_not-an-adapter",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "impostor" }),
    });
    expect(res.status).toBe(401);
    expect(services.registerAdapter).not.toHaveBeenCalled();
  });

  it("maps a service refusal to the same hint-free 401", async () => {
    services.registerAdapter.mockResolvedValue({ ok: false });
    const res = await appRbacOff.request("/v1/channel-adapter/register", {
      method: "POST",
      headers: {
        authorization: "Bearer cha_unknown-not-anchor",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "hopeful" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("registers an accepted token and returns the adapter id", async () => {
    const res = await appRbacOff.request("/v1/channel-adapter/register", {
      method: "POST",
      headers: { ...CHA_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ name: "adapter-1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ adapterId: "ad-1" });
    expect(services.registerAdapter).toHaveBeenCalledWith({
      token: CHA_TOKEN,
      name: "adapter-1",
    });
  });

  it("passes perInstance through and surfaces the minted token", async () => {
    services.registerAdapter.mockResolvedValue({
      ok: true,
      adapterId: "ad-2",
      mintedToken: "cha_minted-instance-credential",
    });
    const res = await appRbacOff.request("/v1/channel-adapter/register", {
      method: "POST",
      headers: { ...CHA_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ name: "adapter-2", perInstance: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      adapterId: "ad-2",
      token: "cha_minted-instance-credential",
    });
    expect(services.registerAdapter).toHaveBeenCalledWith({
      token: CHA_TOKEN,
      name: "adapter-2",
      perInstance: true,
    });
  });

  it("rejects a body without a name", async () => {
    const res = await appRbacOff.request("/v1/channel-adapter/register", {
      method: "POST",
      headers: { ...CHA_AUTH, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect(services.registerAdapter).not.toHaveBeenCalled();
  });
});

describe("the adapter wire (authenticated by a registered cha_ token)", () => {
  it("serves the config feed, and 304s on a matching etag", async () => {
    const first = await appRbacOff.request("/v1/channel-adapter/config", {
      headers: CHA_AUTH,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe("etag-1");
    expect(await first.json()).toEqual({ presences: [], etag: "etag-1" });

    // The route hands the If-None-Match to the SERVICE (which now owns the
    // compare + the decrypt-skip), never comparing locally: proven by the arg
    // and by the 304 still carrying the ETag header.
    const cached = await appRbacOff.request("/v1/channel-adapter/config", {
      headers: { ...CHA_AUTH, "if-none-match": "etag-1" },
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe("etag-1");
    expect(services.getAdapterConfig).toHaveBeenLastCalledWith(
      { adapterId: "ad-1", name: "adapter", kind: "instance" },
      "etag-1",
    );
  });

  it("serves the work poll", async () => {
    const res = await appRbacOff.request("/v1/channel-adapter/work", {
      headers: CHA_AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ finished: [] });
    expect(services.getAdapterWork).toHaveBeenCalledWith("ad-1");
  });

  it("ingest resolves the presence identity and relays the door outcome", async () => {
    const createdAt = new Date("2026-08-06T12:00:00.000Z");
    services.dispatchSlackEvent.mockResolvedValue({
      kind: "message",
      call: {
        door: "direct",
        externalUserId: "U1",
        externalThreadId: "D1",
        text: "hi",
        replyChannel: "D1",
        replyThreadTs: null,
      },
      outcome: {
        kind: "turn",
        conversationId: "cv-1",
        turn: {
          id: "t-1",
          status: "queued",
          source: "slack",
          userId: "user-1",
          message: "hi",
          error: null,
          errorCode: null,
          createdAt,
          finishedAt: null,
        },
      },
    });

    const res = await appRbacOff.request("/v1/channel-adapter/ingest", {
      method: "POST",
      headers: { ...CHA_AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        presenceId: "pr-1",
        eventId: "Ev-1",
        event: { type: "message" },
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: "turn",
      conversationId: "cv-1",
      turn: {
        id: "t-1",
        status: "queued",
        source: "slack",
        userId: "user-1",
        message: "hi",
        error: null,
        errorCode: null,
        createdAt: createdAt.toISOString(),
        finishedAt: null,
      },
      reply: { channel: "D1", threadTs: null },
    });
    // The identity fed to the echo guard came from the CONTROL PLANE's own
    // presence row, not from anything the adapter claimed — and NO `email` is
    // threaded through (the door resolves the speaker control-plane-side).
    expect(services.dispatchSlackEvent).toHaveBeenCalledWith({
      presenceId: "pr-1",
      identityRef: "UBOT",
      event: { type: "message" },
      eventId: "Ev-1",
    });
  });

  it("REJECTS an ingest body carrying an email (the strict schema drops it)", async () => {
    // The wire no longer accepts a caller-asserted email — .strict() turns a
    // body with one into a 422, closing the adapter-impersonation vector.
    const res = await appRbacOff.request("/v1/channel-adapter/ingest", {
      method: "POST",
      headers: { ...CHA_AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        presenceId: "pr-1",
        eventId: "Ev-1",
        event: { type: "message" },
        email: "ceo@example.com",
      }),
    });
    expect(res.status).toBe(422);
    expect(services.dispatchSlackEvent).not.toHaveBeenCalled();
  });

  it("ingest answers 404 for an unknown presence", async () => {
    const res = await appRbacOff.request("/v1/channel-adapter/ingest", {
      method: "POST",
      headers: { ...CHA_AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        presenceId: "pr-unknown",
        eventId: "Ev-1",
        event: {},
      }),
    });
    expect(res.status).toBe(404);
    expect(services.dispatchSlackEvent).not.toHaveBeenCalled();
  });

  it("forwards a decision to the shared decide flow", async () => {
    const res = await appRbacOff.request("/v1/channel-adapter/decision", {
      method: "POST",
      headers: { ...CHA_AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        presenceId: "pr-1",
        approvalId: "ap-1",
        decision: "deny",
        clickerExternalUserId: "U1",
      }),
    });
    expect(res.status).toBe(200);
    expect(services.decideApprovalFromChannel).toHaveBeenCalledWith({
      presenceId: "pr-1",
      approvalId: "ap-1",
      decision: "deny",
      clickerExternalUserId: "U1",
    });
  });

  it("advances the mirror cursor through the CAS service", async () => {
    const res = await appRbacOff.request("/v1/channel-adapter/cursor", {
      method: "POST",
      headers: { ...CHA_AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        linkId: "lnk-1",
        expect: null,
        next: "2026-08-06T12:00:00.000Z",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ advanced: true });
    expect(services.advanceMirrorCursor).toHaveBeenCalledWith(
      "lnk-1",
      null,
      new Date("2026-08-06T12:00:00.000Z"),
    );
  });

  it("clears the turn's reaction receipt ONLY on a winning claim", async () => {
    // MUTATION-TESTED (the `advanced &&` guard): clear on a LOSING claim and
    // the twin that actually posts the answer finds the reaction already
    // gone — the "seen" mark disappears with no answer next to it.
    const claim = (turnId?: string) =>
      appRbacOff.request("/v1/channel-adapter/cursor", {
        method: "POST",
        headers: { ...CHA_AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          linkId: "lnk-1",
          expect: null,
          next: "2026-08-06T12:00:00.000Z",
          ...(turnId && { turnId }),
        }),
      });

    services.advanceMirrorCursor.mockResolvedValue(true);
    await claim("turn-9");
    // The FAMILY clear: the turn's own mark and its joined follow-ups' (the
    // mark may have moved onto one of them mid-run).
    expect(services.clearTurnReceipts).toHaveBeenCalledWith("turn-9");

    services.clearTurnReceipts.mockClear();
    services.advanceMirrorCursor.mockResolvedValue(false);
    await claim("turn-9");
    expect(services.clearTurnReceipts).not.toHaveBeenCalled();

    // No turnId (an older adapter) → no clear either way.
    services.advanceMirrorCursor.mockResolvedValue(true);
    await claim();
    expect(services.clearTurnReceipts).not.toHaveBeenCalled();
  });

  it("runs the proactive rotation sweep and relays its counts", async () => {
    // Staleness is decided SERVER-side; the route is just the adapter's
    // trigger, answering the sweep's counts verbatim.
    services.rotateStaleIntegrations.mockResolvedValue({
      rotated: 2,
      failed: 1,
    });
    const res = await appRbacOff.request(
      "/v1/channel-adapter/rotate-integrations",
      { method: "POST", headers: CHA_AUTH },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rotated: 2, failed: 1 });
    expect(services.rotateStaleIntegrations).toHaveBeenCalledTimes(1);
  });

  it("the rotation sweep needs a registered cha_ token — anything else is 401", async () => {
    // The sweep decrypts and rewrites EVERY org's automation credential; an
    // unauthenticated trigger would let anyone burn each org's single-use
    // refresh token at will (a rotation-DoS). Same fence as the rest of the
    // adapter wire.
    services.rotateStaleIntegrations.mockResolvedValue({
      rotated: 0,
      failed: 0,
    });
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer oc_org_some-user-key" },
      { authorization: "Bearer cha_never-registered" },
    ];
    for (const headers of attempts) {
      const res = await appRbacOff.request(
        "/v1/channel-adapter/rotate-integrations",
        { method: "POST", headers },
      );
      expect(res.status).toBe(401);
    }
    expect(services.rotateStaleIntegrations).not.toHaveBeenCalled();
  });

  it("reads a LINKED conversation's transcript (the link is the fence)", async () => {
    const res = await appRbacOff.request(
      "/v1/channel-adapter/conversations/cv-1/events",
      { headers: CHA_AUTH },
    );
    expect(res.status).toBe(200);
    expect(services.requireLinkedConversation).toHaveBeenCalledWith("cv-1");
    expect(await res.json()).toEqual({
      events: [],
      nextSince: 0,
      hasMore: false,
    });
  });

  it("an UNLINKED conversation reads 404 — the adapter sees only its own threads", async () => {
    services.requireLinkedConversation.mockRejectedValue(
      new ServiceError("NOT_FOUND", "Conversation not found"),
    );
    const res = await appRbacOff.request(
      "/v1/channel-adapter/conversations/cv-foreign/events",
      { headers: CHA_AUTH },
    );
    expect(res.status).toBe(404);
  });

  // ── Approval prompts: the gateway's real deadline crosses the wire ─────────

  it("claim parses an ISO expiresAt into a Date for the service", async () => {
    services.claimApprovalPrompt.mockResolvedValue({ claimed: true });
    const res = await appRbacOff.request("/v1/channel-adapter/prompts/claim", {
      method: "POST",
      headers: { ...CHA_AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        approvalId: "ap-1",
        presenceId: "pr-1",
        externalThreadId: "D1",
        expiresAt: "2026-08-06T12:34:56.000Z",
      }),
    });
    expect(res.status).toBe(200);
    expect(services.claimApprovalPrompt).toHaveBeenCalledWith({
      approvalId: "ap-1",
      agentChannelId: "pr-1",
      externalThreadId: "D1",
      expiresAt: new Date("2026-08-06T12:34:56.000Z"),
    });
  });

  it("claim carries a null expiresAt through as null", async () => {
    services.claimApprovalPrompt.mockResolvedValue({ claimed: true });
    const res = await appRbacOff.request("/v1/channel-adapter/prompts/claim", {
      method: "POST",
      headers: { ...CHA_AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        approvalId: "ap-1",
        presenceId: "pr-1",
        externalThreadId: "D1",
        expiresAt: null,
      }),
    });
    expect(res.status).toBe(200);
    expect(services.claimApprovalPrompt).toHaveBeenCalledWith({
      approvalId: "ap-1",
      agentChannelId: "pr-1",
      externalThreadId: "D1",
      expiresAt: null,
    });
  });

  it("claim rejects a body with no expiresAt key (422) — the field is required", async () => {
    const res = await appRbacOff.request("/v1/channel-adapter/prompts/claim", {
      method: "POST",
      headers: { ...CHA_AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        approvalId: "ap-1",
        presenceId: "pr-1",
        externalThreadId: "D1",
      }),
    });
    expect(res.status).toBe(422);
    expect(services.claimApprovalPrompt).not.toHaveBeenCalled();
  });

  it("unsettled serializes expiresAt to ISO (and null stays null)", async () => {
    services.listUnsettledPrompts.mockResolvedValue([
      {
        id: "p1",
        approvalId: "ap-1",
        agentChannelId: "pr-1",
        externalThreadId: "D1",
        externalMessageRef: "169.1",
        expiresAt: new Date("2026-08-06T12:34:56.000Z"),
        createdAt: new Date("2026-08-06T12:00:00.000Z"),
      },
      {
        id: "p2",
        approvalId: "ap-2",
        agentChannelId: "pr-1",
        externalThreadId: "D2",
        externalMessageRef: null,
        expiresAt: null,
        createdAt: new Date("2026-08-06T12:00:00.000Z"),
      },
    ]);
    const res = await appRbacOff.request(
      "/v1/channel-adapter/prompts/unsettled",
      { headers: CHA_AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prompts: { approvalId: string; expiresAt: string | null }[];
    };
    expect(body.prompts.map((p) => [p.approvalId, p.expiresAt])).toEqual([
      ["ap-1", "2026-08-06T12:34:56.000Z"],
      ["ap-2", null],
    ]);
  });
});

// ── The agent's channel surface ─────────────────────────────────────────────

describe("/v1/agents/:agentId/channels", () => {
  it("serves the section payload, workspace-fenced", async () => {
    const res = await appRbacOff.request("/v1/agents/ag-1/channels", {
      headers: WORKSPACE_HEADERS,
    });
    expect(res.status).toBe(200);
    // The third arg is the CALLER — the service resolves whether they may
    // take the admin-gated "set up Slack for the org" deep link.
    expect(services.getAgentChannels).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "user-1",
    );
  });

  it("creates a presence (201) as the authenticated user, and audits", async () => {
    const res = await appRbacOff.request("/v1/agents/ag-1/channels/slack", {
      method: "POST",
      headers: WORKSPACE_HEADERS,
    });
    expect(res.status).toBe(201);
    expect(services.createPresence).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "slack",
      "user-1",
      undefined,
    );
    expect(dbSpies.auditCreate).toHaveBeenCalled();
  });

  it("passes an explicit transport choice through to the create", async () => {
    const res = await appRbacOff.request("/v1/agents/ag-1/channels/slack", {
      method: "POST",
      headers: { ...WORKSPACE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ transport: "socket" }),
    });
    expect(res.status).toBe(201);
    expect(services.createPresence).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "slack",
      "user-1",
      "socket",
    );
  });

  it("rejects an unknown transport at the schema shell with 422", async () => {
    const res = await appRbacOff.request("/v1/agents/ag-1/channels/slack", {
      method: "POST",
      headers: { ...WORKSPACE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ transport: "carrier-pigeon" }),
    });
    expect(res.status).toBe(422);
    expect(services.createPresence).not.toHaveBeenCalled();
  });

  it("surfaces the service's transport refusals over HTTP: unavailable → 422, mismatch → 409", async () => {
    // The pg suite proves the ServiceError codes; this crosses the HTTP
    // boundary so the errorHandler's STATUS_MAP is exercised for both.
    services.createPresence.mockRejectedValueOnce(
      new ServiceError("UNPROCESSABLE", "Socket Mode isn't available"),
    );
    const unavailable = await appRbacOff.request(
      "/v1/agents/ag-1/channels/slack",
      {
        method: "POST",
        headers: { ...WORKSPACE_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ transport: "socket" }),
      },
    );
    expect(unavailable.status).toBe(422);

    services.createPresence.mockRejectedValueOnce(
      new ServiceError("CONFLICT", "Setup already started"),
    );
    const mismatch = await appRbacOff.request(
      "/v1/agents/ag-1/channels/slack",
      {
        method: "POST",
        headers: { ...WORKSPACE_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ transport: "events" }),
      },
    );
    expect(mismatch.status).toBe(409);
  });

  it("serves the manifest for a requested transport, and 422s an unknown one", async () => {
    services.getSetupMaterial.mockResolvedValue({
      transport: "socket",
      material: {},
    });
    const res = await appRbacOff.request(
      "/v1/agents/ag-1/channels/slack/manifest?transport=socket",
      { headers: WORKSPACE_HEADERS },
    );
    expect(res.status).toBe(200);
    expect(services.getSetupMaterial).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "slack",
      "socket",
    );

    const bad = await appRbacOff.request(
      "/v1/agents/ag-1/channels/slack/manifest?transport=carrier-pigeon",
      { headers: WORKSPACE_HEADERS },
    );
    expect(bad.status).toBe(422);
  });

  it("passes the floor's transport choice through to complete", async () => {
    services.completePresence.mockResolvedValue({
      id: "pr-1",
      provider: "slack",
      externalId: "A100",
      status: "active",
      transport: "socket",
    });
    const res = await appRbacOff.request(
      "/v1/agents/ag-1/channels/slack/complete",
      {
        method: "POST",
        headers: { ...WORKSPACE_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({
          botToken: "xoxb-1",
          appToken: "xapp-1",
          appId: "A100",
          transport: "socket",
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(services.completePresence).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "slack",
      expect.objectContaining({ transport: "socket" }),
      "user-1",
    );
  });

  it("rejects an unknown provider with 404", async () => {
    const res = await appRbacOff.request("/v1/agents/ag-1/channels/teams", {
      method: "POST",
      headers: WORKSPACE_HEADERS,
    });
    expect(res.status).toBe(404);
    expect(services.createPresence).not.toHaveBeenCalled();
  });

  it("surfaces a Slack API refusal as a 422 carrying Slack's code, not a blank 500", async () => {
    // A Slack `ok:false` (an expired token, managed_app_limit_reached, …) is a
    // bad-input outcome the user can act on. The error-handler maps SlackApiError
    // to 422 with the code in the message — WITHOUT this branch it falls through
    // to the unhandled-error 500. (webS2)
    services.createPresence.mockRejectedValue(
      new SlackApiError("apps.manifest.create", "managed_app_limit_reached"),
    );
    const res = await appRbacOff.request("/v1/agents/ag-1/channels/slack", {
      method: "POST",
      headers: WORKSPACE_HEADERS,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("managed_app_limit_reached");
  });

  it("rejects a malformed complete body with 422", async () => {
    const res = await appRbacOff.request(
      "/v1/agents/ag-1/channels/slack/complete",
      {
        method: "POST",
        headers: { ...WORKSPACE_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ appToken: "xapp-only" }),
      },
    );
    expect(res.status).toBe(422);
    expect(services.completePresence).not.toHaveBeenCalled();
  });

  it("detaches with 204, honouring deleteRemote", async () => {
    const res = await appRbacOff.request("/v1/agents/ag-1/channels/slack", {
      method: "DELETE",
      headers: { ...WORKSPACE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ deleteRemote: true }),
    });
    expect(res.status).toBe(204);
    expect(services.detachPresence).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "slack",
      {
        deleteRemote: true,
      },
    );
  });
});

// ── The Slack inbound arm ───────────────────────────────────────────────────

describe("POST /v1/channels/slack/events", () => {
  const envelope = (event: unknown) =>
    JSON.stringify({
      type: "event_callback",
      api_app_id: "A100",
      event_id: "Ev-1",
      event,
    });

  it("echoes url_verification WITHOUT a signature — and with NO side effects", async () => {
    const res = await appRbacOff.request("/v1/channels/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "ch-42" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "ch-42" });
    // A pure echo: no presence lookup, no dispatch, nothing written.
    expect(dbSpies.presenceByAppId).not.toHaveBeenCalled();
    expect(services.dispatchSlackEvent).not.toHaveBeenCalled();
  });

  it("does NOT echo a non-string challenge — it falls through to 401", async () => {
    // MUTATION-TESTED (the `typeof challenge === "string"` guard): the old
    // `&& envelope.challenge` truthiness check would reflect an arbitrary JSON
    // value (here a number) straight back on our origin. It must not echo — it
    // is unsigned and carries no api_app_id, so it lands on the 401.
    const res = await appRbacOff.request("/v1/channels/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: 1234 }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("challenge");
  });

  it("does NOT echo an over-long (>256) challenge string", async () => {
    // MUTATION-TESTED (the `.length <= 256` guard): removing it lets a caller
    // reflect a megabyte string back through our origin. A 300-char challenge
    // must not be echoed.
    const res = await appRbacOff.request("/v1/channels/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "url_verification",
        challenge: "x".repeat(300),
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("challenge");
  });

  it("REJECTS a stale timestamp BEFORE the presence lookup/decrypt (401)", async () => {
    // MUTATION-TESTED (the timestampInWindow pre-filter runs before any DB/KMS
    // work): A-STALE is an uncached app the mock WOULD resolve, so if the
    // pre-filter were removed the lookup spy would fire (then verifySlackSignature
    // rejects the stale ts anyway — but a decrypt-per-flood-request is the DoS
    // the pre-filter closes). The spy staying untouched is the proof.
    const stale = Math.floor(Date.now() / 1000) - 600; // 10 min old
    const body = JSON.stringify({
      type: "event_callback",
      api_app_id: "A-STALE",
      event_id: "Ev-1",
      event: { type: "message" },
    });
    const res = await appRbacOff.request("/v1/channels/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...slackSigned(body, SIGNING_SECRET, stale),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(dbSpies.presenceByAppId).not.toHaveBeenCalled();
    expect(services.dispatchSlackEvent).not.toHaveBeenCalled();
  });

  it("refuses an oversized Content-Length with 413, without buffering", async () => {
    // The declared length is checked FIRST — the body here is tiny, so the only
    // way to reach 413 is the Content-Length pre-check (buffering the 4-byte
    // body would pass the byte-length gate and fall through to 401).
    const res = await appRbacOff.request("/v1/channels/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(1_000_001),
      },
      body: "tiny",
    });
    expect(res.status).toBe(413);
    expect(dbSpies.presenceByAppId).not.toHaveBeenCalled();
  });

  it("caches the per-app signing secret: two inbound events → ONE decrypt", async () => {
    // MUTATION-TESTED (the signing-secret cache): A-CACHE is an uncached app;
    // the first signed event misses the cache (one decrypt), the second within
    // the TTL hits it (no decrypt). Delete the cache and each unauthenticated
    // webhook becomes one KMS decrypt — the count catches exactly that.
    const decryptSpy = vi.spyOn(getCrypto(), "decrypt");
    try {
      const send = async (eventId: string) => {
        const body = JSON.stringify({
          type: "event_callback",
          api_app_id: "A-CACHE",
          event_id: eventId,
          event: { type: "message" },
        });
        return appRbacOff.request("/v1/channels/slack/events", {
          method: "POST",
          headers: { "content-type": "application/json", ...slackSigned(body) },
          body,
        });
      };
      const first = await send("Ev-c1");
      const second = await send("Ev-c2");
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(decryptSpy).toHaveBeenCalledTimes(1);
    } finally {
      decryptSpy.mockRestore();
    }
  });

  it("REFUSES an event with a bad signature — hint-free 401", async () => {
    const body = envelope({ type: "message", text: "forged" });
    const res = await appRbacOff.request("/v1/channels/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...slackSigned(body, "the-wrong-signing-secret"),
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(services.dispatchSlackEvent).not.toHaveBeenCalled();
  });

  it("refuses an event with NO signature headers at all", async () => {
    const body = envelope({ type: "message", text: "unsigned" });
    const res = await appRbacOff.request("/v1/channels/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
    expect(services.dispatchSlackEvent).not.toHaveBeenCalled();
  });

  it("refuses an event naming an UNKNOWN app id", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      api_app_id: "A-nobody",
      event_id: "Ev-1",
      event: { type: "message" },
    });
    const res = await appRbacOff.request("/v1/channels/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...slackSigned(body) },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("dispatches a correctly signed event to the shared door", async () => {
    const event = { type: "message", channel: "D1", text: "hello" };
    const body = envelope(event);
    const res = await appRbacOff.request("/v1/channels/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...slackSigned(body) },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(services.dispatchSlackEvent).toHaveBeenCalledWith({
      presenceId: "pr-1",
      identityRef: "UBOT",
      event,
      eventId: "Ev-1",
    });
  });

  it("answers an invite REFUSAL with the refusal post ONLY — no leave call", async () => {
    // Refuse-and-stay-muted on the events arm: leaving a channel needs
    // channels:manage/groups:write, scopes the manifest deliberately never
    // requests — a conversations.leave here would just be a missing_scope
    // error. MUTATION-TESTED: reintroduce a leave after the refusal post and
    // the second outbound call shows up in the fetch spy's URL list.
    services.dispatchSlackEvent.mockResolvedValue({
      kind: "invite",
      call: { door: "invite", inviterExternalUserId: "U404", channel: "C9" },
      outcome: {
        kind: "refuse",
        leave: false,
        message:
          "No access. I'll stay muted in this channel. Anyone can remove me from it.",
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, channel: "C9", ts: "9.1" })),
      );
    try {
      const body = envelope({
        type: "member_joined_channel",
        channel: "C9",
        user: "UBOT",
        inviter: "U404",
      });
      const res = await appRbacOff.request("/v1/channels/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json", ...slackSigned(body) },
        body,
      });
      expect(res.status).toBe(200);

      // The refusal fires WITHOUT blocking the ack — wait for it to land.
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain("/chat.postMessage");
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("channel")).toBe("C9");
      expect(form.get("text")).toContain("stay muted in this channel");
      // This agent has no avatar — the post carries no icon_url at all.
      expect(form.get("icon_url")).toBeNull();
      // And that post is the ONLY outbound call — nothing tried to leave.
      expect(fetchSpy.mock.calls.map(([u]) => String(u))).toEqual([
        expect.stringContaining("/chat.postMessage"),
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("carries the agent's avatar as icon_url on an events-arm refusal — with a plain retry on missing_scope", async () => {
    // The socket arm's parity contract: same icon, same `missing_scope`
    // carve (an install predating chat:write.customize must still get the
    // refusal, just without the icon).
    services.dispatchSlackEvent.mockResolvedValue({
      kind: "invite",
      call: { door: "invite", inviterExternalUserId: "U404", channel: "C9" },
      outcome: { kind: "refuse", leave: false, message: "No access." },
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "missing_scope" })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, channel: "C9", ts: "9.2" })),
      );
    try {
      const body = JSON.stringify({
        type: "event_callback",
        api_app_id: "A-ICON",
        event_id: "Ev-icon-1",
        event: {
          type: "member_joined_channel",
          channel: "C9",
          user: "UBOT",
          inviter: "U404",
        },
      });
      const res = await appRbacOff.request("/v1/channels/slack/events", {
        method: "POST",
        headers: { "content-type": "application/json", ...slackSigned(body) },
        body,
      });
      expect(res.status).toBe(200);

      // First attempt carries the derived key-fenced icon…
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      const first = new URLSearchParams(
        String(fetchSpy.mock.calls[0]![1]?.body),
      );
      expect(first.get("icon_url")).toContain(
        `/v1/agent-images/ag-icon/${"k".repeat(32)}`,
      );
      // …and the missing_scope answer retried the SAME refusal plain.
      const second = new URLSearchParams(
        String(fetchSpy.mock.calls[1]![1]?.body),
      );
      expect(second.get("icon_url")).toBeNull();
      expect(second.get("text")).toBe(first.get("text"));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("acks a signed non-event envelope without dispatching", async () => {
    const body = JSON.stringify({
      type: "app_rate_limited",
      api_app_id: "A100",
    });
    const res = await appRbacOff.request("/v1/channels/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...slackSigned(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(services.dispatchSlackEvent).not.toHaveBeenCalled();
  });

  it("rejects unparseable JSON with 400", async () => {
    const res = await appRbacOff.request("/v1/channels/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/channels/slack/interactivity", () => {
  const interactivityBody = (payload: unknown) =>
    `payload=${encodeURIComponent(JSON.stringify(payload))}`;

  const approvePayload = {
    type: "block_actions",
    api_app_id: "A100",
    user: { id: "U-clicker" },
    actions: [{ action_id: "channel_approve", value: "ap-77" }],
  };

  it("REFUSES a bad signature before reading any action", async () => {
    const body = interactivityBody(approvePayload);
    const res = await appRbacOff.request("/v1/channels/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...slackSigned(body, "the-wrong-signing-secret"),
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(services.decideApprovalFromChannel).not.toHaveBeenCalled();
  });

  it("decides a correctly signed button click as THAT clicker", async () => {
    const body = interactivityBody(approvePayload);
    const res = await appRbacOff.request("/v1/channels/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...slackSigned(body),
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(services.decideApprovalFromChannel).toHaveBeenCalledWith({
      presenceId: "pr-1",
      approvalId: "ap-77",
      decision: "approve",
      clickerExternalUserId: "U-clicker",
    });
  });

  it("does NOT POST to a response_url outside hooks.slack.com (SSRF allowlist)", async () => {
    // MUTATION-TESTED (the isSlackResponseUrl allowlist): the payload is signed,
    // but the signing secret is known to whoever attached the presence — so a
    // member could name an INTERNAL url and turn the card update into a blind
    // SSRF POST from inside the VPC. Delete the allowlist and this
    // metadata-endpoint URL gets fetched. The decision still PROCESSES; only the
    // post is withheld.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    try {
      const body = interactivityBody({
        ...approvePayload,
        response_url: "http://169.254.169.254/latest/meta-data/",
      });
      const res = await appRbacOff.request("/v1/channels/slack/interactivity", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...slackSigned(body),
        },
        body,
      });
      expect(res.status).toBe(200);
      expect(services.decideApprovalFromChannel).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("DOES POST to a valid hooks.slack.com response_url", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    try {
      const responseUrl = "https://hooks.slack.com/actions/T1/B1/abc";
      const body = interactivityBody({
        ...approvePayload,
        response_url: responseUrl,
      });
      const res = await appRbacOff.request("/v1/channels/slack/interactivity", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...slackSigned(body),
        },
        body,
      });
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(responseUrl);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("ignores signed payloads that are not our approval actions", async () => {
    const body = interactivityBody({
      ...approvePayload,
      actions: [{ action_id: "some_other_button", value: "x" }],
    });
    const res = await appRbacOff.request("/v1/channels/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...slackSigned(body),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(services.decideApprovalFromChannel).not.toHaveBeenCalled();
  });

  it("rejects a body with no payload field", async () => {
    const res = await appRbacOff.request("/v1/channels/slack/interactivity", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "not_payload=1",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/channels/slack/oauth/callback", () => {
  it("a valid state lands the install and redirects home to the agent's channels", async () => {
    services.completePresenceFromOAuth.mockResolvedValue({
      presence: { id: "pr-1" },
      agentId: "ag-1",
      workspaceId: "p1",
    });

    const res = await appRbacOff.request(
      "/v1/channels/slack/oauth/callback?state=signed-state&code=slack-code",
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.example.test/w/p1/agents/ag-1/channels?connected=slack",
    );
    // The exchange used OUR configured API origin — the exact redirect URI
    // the manifest registered — never anything derived from the request.
    expect(services.completePresenceFromOAuth).toHaveBeenCalledWith({
      state: "signed-state",
      code: "slack-code",
      redirectUri: "https://api.example.test/v1/channels/slack/oauth/callback",
    });
  });

  it("a BAD state answers 400 html, not a redirect", async () => {
    services.completePresenceFromOAuth.mockRejectedValue(
      new ServiceError("UNPROCESSABLE", "This install link is not valid"),
    );

    const res = await appRbacOff.request(
      "/v1/channels/slack/oauth/callback?state=forged&code=slack-code",
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("This install link is not valid");
  });

  it("a missing code is refused WITHOUT calling the service", async () => {
    const res = await appRbacOff.request(
      "/v1/channels/slack/oauth/callback?state=only-a-state",
    );
    expect(res.status).toBe(400);
    expect(services.completePresenceFromOAuth).not.toHaveBeenCalled();
  });

  it("a code with NO state parks at the app (the marketplace install path)", async () => {
    // An install begun in Slack's app directory has no state to sign — no
    // OneCLI session existed when it started. Refusing it (the old behavior)
    // is what a Marketplace reviewer would have seen.
    const res = await appRbacOff.request(
      "/v1/channels/slack/oauth/callback?code=directory-code",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.example.test/slack/installed?code=directory-code",
    );
    // Nothing is exchanged yet: the org is unknown until someone signs in.
    expect(services.completePresenceFromOAuth).not.toHaveBeenCalled();
  });

  it("a cancelled install is a friendly 400, not an error page", async () => {
    const res = await appRbacOff.request(
      "/v1/channels/slack/oauth/callback?error=access_denied",
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("cancelled");
    expect(services.completePresenceFromOAuth).not.toHaveBeenCalled();
  });
});
