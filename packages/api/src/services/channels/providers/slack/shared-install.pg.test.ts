import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../../../../testing/pg-proof.js";

/**
 * The SHARED Slack app lifecycle on real PostgreSQL: the org-level install
 * (OAuth state laws, the one-workspace-one-org conflict law, reinstall
 * token refresh), the org-facing shared-app view, and the disconnect
 * teardown.
 *
 * Same seams as channels.pg.test.ts: `SLACK_API_BASE_URL` points at a local
 * fake; the shared-app config arrives by `SLACK_SHARED_*` env.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type SharedInstall = typeof import("./shared-install-service");
type OAuthState = typeof import("../../../../lib/oauth-state");
type Providers = typeof import("../../../../providers");

let db: Db;
let sharedInstall: SharedInstall;
let oauthState: OAuthState;
let getCrypto: Providers["getCrypto"];
let initSelfUrl: Providers["initSelfUrl"];

const P = "shd-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}org-other`;
const WORKSPACE = `${P}proj`;
const OTHER_WORKSPACE = `${P}proj-other`;
const ADMIN = `${P}admin`;
const MEMBER = `${P}member`;
const OUTSIDER = `${P}outsider`;

const TEAM = "T-SHARED-1";
const SELF_URL = "https://api.shared.test";

// ── The fake Slack Web API ──────────────────────────────────────────────────

interface SlackCall {
  method: string;
  form: URLSearchParams;
  token: string | null;
  authorization: string | null;
}

let slackServer: Server;
let slackCalls: SlackCall[] = [];
let slackHandlers: Record<string, (call: SlackCall) => unknown> = {};

const slackCallsFor = (method: string) =>
  slackCalls.filter((c) => c.method === method);

const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const method = (req.url ?? "/").slice(1);
        const auth = req.headers.authorization ?? null;
        const call: SlackCall = {
          method,
          form: new URLSearchParams(raw),
          token: auth?.startsWith("Bearer ") ? auth.slice(7) : null,
          authorization: auth,
        };
        slackCalls.push(call);
        const handler = slackHandlers[method];
        const body = handler
          ? handler(call)
          : { ok: false, error: `test_unscripted_${method}` };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

const scriptOauthAccess = (
  overrides: Partial<{
    teamId: string;
    teamName: string;
    botToken: string;
    botUserId: string;
    appId: string;
    /** The installing admin's USER grant — present when the consent kept the
     * user scopes (the mint capability + the targeted-strip identity). */
    authedUser: { id: string; access_token: string; scope: string };
  }> = {},
) => {
  slackHandlers["oauth.v2.access"] = () => ({
    ok: true,
    access_token: overrides.botToken ?? "xoxb-shared-token",
    bot_user_id: overrides.botUserId ?? "USHAREDBOT",
    app_id: overrides.appId ?? "A0SHARED",
    team: {
      id: overrides.teamId ?? TEAM,
      name: overrides.teamName ?? "Shared Acme",
    },
    ...(overrides.authedUser && { authed_user: overrides.authedUser }),
  });
};

// ── Fixtures ────────────────────────────────────────────────────────────────

const reset = async () => {
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.apiKey.deleteMany({ where: { userId: { startsWith: P } } });
  slackCalls = [];
  slackHandlers = {};
};

const dropAll = async () => {
  await reset();
  await db.organizationMember.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
};

const installState = (
  overrides: Partial<{
    kind: string;
    organizationId: string;
    actorUserId: string;
    issuedAt: number;
  }> = {},
) =>
  oauthState.signOAuthState({
    provider: "slack",
    nonce: "n1",
    kind: overrides.kind ?? "shared-install",
    organizationId: overrides.organizationId ?? ORG,
    actorUserId: overrides.actorUserId ?? ADMIN,
    issuedAt: overrides.issuedAt ?? Date.now(),
  });

const completeInstall = (state?: string) =>
  sharedInstall.completeSharedInstallFromOAuth({
    state: state ?? installState(),
    code: "code-1",
    redirectUri: `${SELF_URL}/v1/channels/slack/oauth/callback`,
  });

beforeAll(async () => {
  if (!PROOF_URL) return;

  const slackUrl = await startSlackFake();

  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.SLACK_API_BASE_URL = slackUrl;
  process.env.SLACK_SHARED_CLIENT_ID = "111.222";
  process.env.SLACK_SHARED_CLIENT_SECRET = "shared-secret";
  process.env.SLACK_SHARED_SIGNING_SECRET = "shared-signing";
  process.env.SLACK_SHARED_APP_ID = "A0SHARED";

  ({ db } = await import("@onecli/db"));
  sharedInstall = await import("./shared-install-service");
  oauthState = await import("../../../../lib/oauth-state");
  ({ getCrypto, initSelfUrl } = await import("../../../../providers"));
  initSelfUrl(SELF_URL);

  await dropAll();
  await db.organization.createMany({
    data: [
      { id: ORG, name: ORG, slug: ORG },
      { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
    ],
  });
  await db.workspace.createMany({
    data: [
      { id: WORKSPACE, name: "Shared Workspace", organizationId: ORG },
      { id: OTHER_WORKSPACE, name: "Elsewhere", organizationId: OTHER_ORG },
    ],
  });
  await db.user.createMany({
    data: [
      {
        id: ADMIN,
        email: `${ADMIN}@example.com`,
        externalAuthId: ADMIN,
        name: "Admin",
      },
      {
        id: MEMBER,
        email: `${MEMBER}@example.com`,
        externalAuthId: MEMBER,
        name: "Member",
      },
      {
        id: OUTSIDER,
        email: `${OUTSIDER}@example.com`,
        externalAuthId: OUTSIDER,
        name: "Outsider",
      },
    ],
  });
  await db.organizationMember.createMany({
    data: [
      {
        organizationId: ORG,
        userId: ADMIN,
        userEmail: `${ADMIN}@example.com`,
        role: "admin",
      },
      {
        organizationId: ORG,
        userId: MEMBER,
        userEmail: `${MEMBER}@example.com`,
        role: "member",
      },
      {
        organizationId: OTHER_ORG,
        userId: OUTSIDER,
        userEmail: `${OUTSIDER}@example.com`,
        role: "admin",
      },
    ],
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await dropAll();
  await db.$disconnect();
  slackServer?.close();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
});

describe.skipIf(!PROOF_URL)("startSharedInstall", () => {
  it("mints a consent URL carrying the signed state and the deployment client id", () => {
    const { installUrl } = sharedInstall.startSharedInstall({
      organizationId: ORG,
      actorUserId: ADMIN,
    });
    const url = new URL(installUrl);
    expect(url.origin + url.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("111.222");
    const state = oauthState.verifyOAuthState(
      url.searchParams.get("state") ?? "",
    );
    expect(state).toMatchObject({
      kind: "shared-install",
      organizationId: ORG,
      actorUserId: ADMIN,
    });
  });
});

describe.skipIf(!PROOF_URL)("completeSharedInstallFromOAuth", () => {
  it("records the installation: integration row, team binding, encrypted bot token", async () => {
    scriptOauthAccess();
    const result = await completeInstall();
    expect(result.organizationId).toBe(ORG);

    const row = await db.channelInstallation.findUniqueOrThrow({
      where: { provider_externalId: { provider: "slack", externalId: TEAM } },
      select: {
        appId: true,
        botUserId: true,
        credentials: true,
        integration: {
          select: { organizationId: true, externalId: true, name: true },
        },
      },
    });
    expect(row.appId).toBe("A0SHARED");
    expect(row.botUserId).toBe("USHAREDBOT");
    expect(row.integration.organizationId).toBe(ORG);
    expect(row.integration.externalId).toBe(TEAM);
    expect(row.integration.name).toBe("Shared Acme");
    const creds = JSON.parse(await getCrypto().decrypt(row.credentials)) as {
      botToken: string;
    };
    expect(creds.botToken).toBe("xoxb-shared-token");

    // The exchange used the DEPLOYMENT's client creds, as HTTP Basic.
    const [call] = slackCallsFor("oauth.v2.access");
    expect(call?.authorization).toBe(
      `Basic ${Buffer.from("111.222:shared-secret").toString("base64")}`,
    );
  });

  it("refuses a state of the WRONG KIND (a per-agent install link can't mint an org install)", async () => {
    scriptOauthAccess();
    await expect(
      completeInstall(installState({ kind: "channel-install" })),
    ).rejects.toThrow("not valid");
  });

  it("refuses an EXPIRED state", async () => {
    scriptOauthAccess();
    await expect(
      completeInstall(
        installState({ issuedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
      ),
    ).rejects.toThrow("not valid");
  });

  it("refuses when the actor is no longer an org member — a departed admin's link dies with them", async () => {
    scriptOauthAccess();
    await expect(
      completeInstall(installState({ actorUserId: OUTSIDER })),
    ).rejects.toThrow("not valid");
  });

  it("CONFLICTS when another org already claimed the workspace", async () => {
    scriptOauthAccess();
    await completeInstall();
    await expect(
      completeInstall(
        installState({ organizationId: OTHER_ORG, actorUserId: OUTSIDER }),
      ),
    ).rejects.toThrow("already connected to another organization");
  });

  it("CONFLICTS when the org's integration points at a DIFFERENT workspace", async () => {
    await db.channelIntegration.create({
      data: {
        organizationId: ORG,
        provider: "slack",
        externalId: "T-OTHER-TEAM",
        createdByUserId: ADMIN,
      },
    });
    scriptOauthAccess();
    await expect(completeInstall()).rejects.toThrow("different workspace");
  });

  it("a REINSTALL (same org, same workspace) refreshes the token and bot id in place", async () => {
    scriptOauthAccess();
    await completeInstall();

    scriptOauthAccess({ botToken: "xoxb-rotated", botUserId: "UNEWBOT" });
    await completeInstall();

    const rows = await db.channelInstallation.findMany({
      where: { provider: "slack", externalId: TEAM },
      select: { botUserId: true, credentials: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.botUserId).toBe("UNEWBOT");
    const creds = JSON.parse(
      await getCrypto().decrypt(rows[0]?.credentials ?? ""),
    ) as { botToken: string };
    expect(creds.botToken).toBe("xoxb-rotated");
  });
});

describe.skipIf(!PROOF_URL)("stripSharedInstallUserToken", () => {
  const decryptInstallCredentials = async () => {
    const row = await db.channelInstallation.findUniqueOrThrow({
      where: { provider_externalId: { provider: "slack", externalId: TEAM } },
      select: { credentials: true },
    });
    return JSON.parse(await getCrypto().decrypt(row.credentials)) as {
      botToken?: string;
      userToken?: string;
      userTokenScopes?: string;
      installerSlackUserId?: string;
    };
  };

  it("strips ONLY on the stored installer's revocation — and on ANY when no installer id was recorded", async () => {
    scriptOauthAccess({
      authedUser: {
        id: "UINSTALLER",
        access_token: "xoxp-strip-user",
        scope: "app_configurations:write,managed_apps:install",
      },
    });
    await completeInstall();

    // A DIFFERENT member's revocation is a no-op: the installer's grant
    // (and with it the mint capability) lives on.
    await sharedInstall.stripSharedInstallUserToken(TEAM, ["USOMEBODY-ELSE"]);
    let creds = await decryptInstallCredentials();
    expect(creds.installerSlackUserId).toBe("UINSTALLER");
    expect(creds.userToken).toBe("xoxp-strip-user");

    // The INSTALLER's own revocation strips the user token; the bot stays.
    await sharedInstall.stripSharedInstallUserToken(TEAM, ["UINSTALLER"]);
    creds = await decryptInstallCredentials();
    expect(creds.userToken).toBeUndefined();
    expect(creds.userTokenScopes).toBeUndefined();
    expect(creds.botToken).toBe("xoxb-shared-token");

    // LEGACY credentials (recorded before the installer id was persisted)
    // strip on ANY revocation — the safe side: a possibly-dead token reads
    // as "no capability" instead of failing at call time.
    const row = await db.channelInstallation.findUniqueOrThrow({
      where: { provider_externalId: { provider: "slack", externalId: TEAM } },
      select: { id: true },
    });
    await db.channelInstallation.update({
      where: { id: row.id },
      data: {
        credentials: await getCrypto().encrypt(
          JSON.stringify({
            botToken: "xoxb-shared-token",
            userToken: "xoxp-legacy",
            userTokenScopes: "app_configurations:write",
          }),
        ),
      },
    });
    await sharedInstall.stripSharedInstallUserToken(TEAM, ["UANYBODY"]);
    creds = await decryptInstallCredentials();
    expect(creds.userToken).toBeUndefined();
    expect(creds.botToken).toBe("xoxb-shared-token");
  });
});

describe.skipIf(!PROOF_URL)("getSharedAppView", () => {
  it("advertises on credentials + a public origin, and shows an existing install", async () => {
    scriptOauthAccess();
    await completeInstall();

    const view = await sharedInstall.getSharedAppView(ORG);
    // Credentials + public origin are the whole advertisement switch.
    expect(view.available).toBe(true);
    // The install made from Slack's side is shown — and removable.
    expect(view.installation).toMatchObject({
      tenant: { externalId: TEAM, name: "Shared Acme" },
      botUserId: "USHAREDBOT",
    });
  });

  it("installMintsAgentApps follows the manager-approval switch — the web's setup-choice default", async () => {
    // Unapproved (this suite's default env): a new install is onboarding-
    // only, so the token paste leads the choice.
    expect(
      (await sharedInstall.getSharedAppView(ORG)).installMintsAgentApps,
    ).toBe(false);
    process.env.SLACK_SHARED_APP_MANAGER_APPROVED = "true";
    try {
      expect(
        (await sharedInstall.getSharedAppView(ORG)).installMintsAgentApps,
      ).toBe(true);
    } finally {
      delete process.env.SLACK_SHARED_APP_MANAGER_APPROVED;
    }
  });
});

describe.skipIf(!PROOF_URL)("disconnectSharedInstall", () => {
  it("uninstalls from Slack best-effort and deletes the install row", async () => {
    scriptOauthAccess();
    await completeInstall();
    slackHandlers["apps.uninstall"] = () => ({ ok: true });
    slackCalls = [];

    expect(await sharedInstall.disconnectSharedInstall(ORG)).toBe(true);
    expect(slackCallsFor("apps.uninstall")).toHaveLength(1);
    expect(
      await db.channelInstallation.findFirst({
        where: { integration: { organizationId: ORG } },
      }),
    ).toBeNull();
  });

  it("still disconnects locally when Slack refuses the uninstall", async () => {
    scriptOauthAccess();
    await completeInstall();
    slackHandlers["apps.uninstall"] = () => ({
      ok: false,
      error: "account_inactive",
    });
    expect(await sharedInstall.disconnectSharedInstall(ORG)).toBe(true);
    expect(
      await db.channelInstallation.findFirst({
        where: { integration: { organizationId: ORG } },
      }),
    ).toBeNull();
  });

  it("answers false when nothing is installed", async () => {
    expect(await sharedInstall.disconnectSharedInstall(ORG)).toBe(false);
  });
});

describe.skipIf(!PROOF_URL)(
  "disconnectIntegration beside a live install",
  () => {
    it("clears the automation credential but never cascades the install away", async () => {
      scriptOauthAccess();
      await completeInstall();
      // A pasted config token beside the install — the guard under test never
      // decrypts it, so any opaque value works.
      await db.channelIntegration.update({
        where: {
          organizationId_provider: { organizationId: ORG, provider: "slack" },
        },
        data: { credentials: "opaque-ciphertext" },
      });

      const integrations = await import("../../channel-integration-service");
      await integrations.disconnectIntegration(ORG, "slack");

      // Dropping a mere automation credential must not FK-cascade the live
      // shared install (and the team-onboarding bot) away with it.
      expect(
        await db.channelInstallation.count({
          where: { integration: { organizationId: ORG } },
        }),
      ).toBe(1);
      const integration = await db.channelIntegration.findUnique({
        where: {
          organizationId_provider: { organizationId: ORG, provider: "slack" },
        },
        select: { credentials: true },
      });
      expect(integration).not.toBeNull();
      expect(integration?.credentials).toBeNull();
    });
  },
);
