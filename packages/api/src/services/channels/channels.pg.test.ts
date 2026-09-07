import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * The channels control plane (step 6) on REAL PostgreSQL: the org integration
 * lifecycle with its rotate-on-use law, the presence attach/activate/detach
 * arc, the ingestion doors' fences and idempotency, the adapter's config/work
 * feed with its CAS cursor, and the approval decide flow against a fake
 * gateway.
 *
 * Outbound HTTP is the designed seam, not a mock: the Slack Web API client
 * reads `SLACK_API_BASE_URL` at call time and the gateway client reads
 * `GATEWAY_INTERNAL_URL` at module load, so both point at local `node:http`
 * fakes whose scripts and hit counts the tests assert on.
 *
 * NOTE on the access fence: these suites run onprem (no RBAC), where
 * `canAccessWorkspaceAsUser` is always true — so the arm proven here is the
 * org-MEMBERSHIP fence (non-members and suspended members refused). The RBAC
 * arm is exercised by `canAccessWorkspaceAsUser`'s own existing coverage.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Integrations = typeof import("./channel-integration-service");
type AgentChannels = typeof import("./agent-channel-service");
type Ingestion = typeof import("./channel-ingestion-service");
type Adapters = typeof import("./channel-adapter-service");
type Approvals = typeof import("./channel-approval-service");
type Dispatch = typeof import("./providers/slack/dispatch");
type ApiKeys = typeof import("../api-key-service");
type Providers = typeof import("../../providers");
type Receipts = typeof import("./turn-receipt-service");
type Validations = typeof import("../../validations/conversation");
type DecryptCache = typeof import("./channel-decrypt-cache");

let db: Db;
let integrations: Integrations;
let agentChannels: AgentChannels;
let ingestion: Ingestion;
let adapters: Adapters;
let approvals: Approvals;
let dispatch: Dispatch;
let apiKeys: ApiKeys;
let receipts: Receipts;
let validations: Validations;
let decryptCache: DecryptCache;
let getCrypto: Providers["getCrypto"];
let initSelfUrl: Providers["initSelfUrl"];
let initAttachmentStore: Providers["initAttachmentStore"];

const P = "chn-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}org-other`;
const WORKSPACE = `${P}proj`;
const OTHER_WORKSPACE = `${P}proj-other`;
/** The actor who connects/attaches — an active org member. */
const ADMIN = `${P}admin`;
/** An active member: the authorized Slack speaker. */
const MEMBER = `${P}member`;
/** A User row with NO membership anywhere — the membership fence's target. */
const OUTSIDER = `${P}outsider`;
/** A member with status "suspended" — treated as a non-member everywhere. */
const SUSPENDED = `${P}suspended`;
/** Name carries control chars on purpose — the cleanName test's subject. */
const CTRL_NAME_USER = `${P}ctrl`;

const ADAPTER_ANCHOR = `cha_${P}instance-anchor-token`;
const SOCKET_SELF_URL = "http://localhost:10256";
const EVENTS_SELF_URL = "https://api.example.test";

const nowSec = () => Math.floor(Date.now() / 1000);

// ── The fake Slack Web API ──────────────────────────────────────────────────

interface SlackCall {
  method: string;
  form: URLSearchParams;
  /** The raw request body, for the JSON-bodied methods (the streaming trio
   * sends a `chunks` array, which cannot survive form encoding). */
  raw: string;
  /** The Bearer token, when the call carried one (the convenience view). */
  token: string | null;
  /** The RAW Authorization header — the Basic-auth assertion surface
   * (oauth.v2.access sends client creds as Basic, never as a Bearer). */
  authorization: string | null;
}

let slackServer: Server;
let slackCalls: SlackCall[] = [];
/** Per-test scripts, keyed by Slack method ("tooling.tokens.rotate", ...). */
let slackHandlers: Record<string, (call: SlackCall) => unknown> = {};

const slackCallsFor = (method: string) =>
  slackCalls.filter((c) => c.method === method);

// ── The fake Slack file CDN ─────────────────────────────────────────────────
// A SECOND origin, deliberately distinct from the fake Web API: Slack 302s
// authenticated non-image downloads to its presigned safe-files CDN
// (slack-files.com), and the download path treats that host set differently
// (no Authorization header). Same recording shape as the Web API fake so the
// tests can assert what each origin was sent.

let cdnServer: Server;
let cdnCalls: SlackCall[] = [];
let cdnHandlers: Record<
  string,
  (call: SlackCall) => { bytes: Buffer; contentType: string }
> = {};

const startCdnFake = (): Promise<string> =>
  new Promise((resolve) => {
    cdnServer = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const path = (req.url ?? "/").slice(1);
        const auth = req.headers.authorization ?? null;
        const call: SlackCall = {
          method: path,
          form: new URLSearchParams(),
          // The CDN fake serves file bytes, never a Web API method body.
          raw: "",
          token: auth?.startsWith("Bearer ") ? auth.slice(7) : null,
          authorization: auth,
        };
        cdnCalls.push(call);
        const handler = cdnHandlers[path];
        if (!handler) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not scripted");
          return;
        }
        const binary = handler(call);
        res.writeHead(200, {
          "content-type": binary.contentType,
          "content-length": String(binary.bytes.byteLength),
        });
        res.end(binary.bytes);
      });
    });
    cdnServer.listen(0, "127.0.0.1", () => {
      const { port } = cdnServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      // Async so a handler can interleave a real DB write BEFORE it responds —
      // the rotation-race test uses that to stand in for a concurrent winner.
      // Every plain-object handler stays valid (awaiting a non-promise is a
      // no-op).
      req.on("end", () => {
        void (async () => {
          const method = (req.url ?? "/").slice(1);
          const auth = req.headers.authorization ?? null;
          const call: SlackCall = {
            method,
            form: new URLSearchParams(raw),
            raw,
            token: auth?.startsWith("Bearer ") ? auth.slice(7) : null,
            authorization: auth,
          };
          slackCalls.push(call);
          const handler = slackHandlers[method];
          // Unscripted methods refuse loudly, naming themselves — a stray call
          // in a test that expects none surfaces as a SlackApiError, not a hang.
          const body = handler
            ? await handler(call)
            : { ok: false, error: `test_unscripted_${method}` };
          // A handler may answer BINARY (the url_private download tests):
          // `{ __binary: { bytes, contentType } }` writes raw bytes instead
          // of the JSON envelope every Web API method speaks.
          if (
            body &&
            typeof body === "object" &&
            "__binary" in (body as Record<string, unknown>)
          ) {
            const binary = (
              body as {
                __binary: { bytes: Buffer; contentType: string };
              }
            ).__binary;
            res.writeHead(200, {
              "content-type": binary.contentType,
              "content-length": String(binary.bytes.byteLength),
            });
            res.end(binary.bytes);
            return;
          }
          // ... or a REDIRECT (`{ __redirect: url }`) — how Slack answers an
          // authenticated non-image `files-pri` download (302 to the CDN).
          if (
            body &&
            typeof body === "object" &&
            "__redirect" in (body as Record<string, unknown>)
          ) {
            res.writeHead(302, {
              location: (body as { __redirect: string }).__redirect,
            });
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        })();
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

// ── The fake gateway (approvals decision endpoint) ──────────────────────────

interface GatewayCall {
  path: string;
  auth: string | null;
  body: unknown;
}

let gatewayServer: Server;
let gatewayCalls: GatewayCall[] = [];
let gatewayRespond: (call: GatewayCall) => {
  status: number;
  body?: unknown;
} = () => ({ status: 200, body: { success: true } });

const startGatewayFake = (): Promise<string> =>
  new Promise((resolve) => {
    gatewayServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const call: GatewayCall = {
          path: req.url ?? "/",
          auth: req.headers.authorization ?? null,
          body: raw ? JSON.parse(raw) : null,
        };
        gatewayCalls.push(call);
        const { status, body } = gatewayRespond(call);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body ?? {}));
      });
    });
    gatewayServer.listen(0, "127.0.0.1", () => {
      const { port } = gatewayServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

// ── Fixtures ────────────────────────────────────────────────────────────────

const reset = async () => {
  // Prefix-fenced: the proof database is shared with the other pg suites.
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.channelAdapter.deleteMany({
    // Token-prefix catches the seeded callers; NAME-prefix catches mint-path
    // rows, whose tokens are random `cha_<hex>` (the tests always register
    // them under P-prefixed names).
    where: {
      OR: [{ token: { startsWith: `cha_${P}` } }, { name: { startsWith: P } }],
    },
  });
  // Presences, thread links, ingested events and approval prompts cascade
  // from the agents; user links cascade from the integrations.
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.apiKey.deleteMany({ where: { userId: { startsWith: P } } });
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
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

/** An adapter caller for the owner-scoped feeds. One live adapter ⇒ fair
 * share = the whole fleet, so its first `getAdapterConfig` claims every
 * eligible presence — the self-host singleton shape these suites were
 * written against. Prefix-fenced token so `reset` reaps the row. */
let adapterCallerSeq = 0;
const seedAdapterCaller = async (kind: "anchor" | "instance" = "anchor") => {
  adapterCallerSeq += 1;
  const row = await db.channelAdapter.create({
    data: {
      token: `cha_${P}caller-${adapterCallerSeq}`,
      name: `${P}caller-${adapterCallerSeq}`,
      kind,
      lastSeenAt: new Date(),
    },
    select: { id: true, kind: true },
  });
  return { adapterId: row.id, kind: row.kind };
};

/** A caller that already CLAIMED the fleet — the work/prompt feeds are
 * owner-scoped and never claim; the config poll does. Seed presences BEFORE
 * calling this, or they stay unowned until another config poll. */
const seedClaimedCaller = async () => {
  const caller = await seedAdapterCaller();
  await adapters.getAdapterConfig(caller);
  return caller;
};

/** Copied law from conversation.pg.test.ts: a hosted agent needs an
 * injectable LLM key or door 1 fails its turns outright. */
const grantLlmKey = async (agentId: string, suffix: string) => {
  const secret = await db.secret.create({
    data: {
      scope: "workspace",
      workspaceId: WORKSPACE,
      name: `${P}${suffix}`,
      type: "anthropic",
      encryptedValue: "enc",
      hostPattern: "api.anthropic.com",
      metadata: { authMode: "api-key" },
    },
    select: { id: true },
  });
  await db.policyRuleV2.create({
    data: {
      scope: "workspace",
      workspaceId: WORKSPACE,
      status: "published",
      generation: 1,
      priority: 10,
      isDefault: false,
      enabled: true,
      source: "equipment",
      logicalId: `${P}${suffix}`,
      name: `${P}${suffix}`,
      action: "allow",
      requireApproval: false,
      identities: { create: [{ agentId }] },
      targets: { create: [{ kind: "secret", secretId: secret.id }] },
    },
  });
};

const seedAgent = async (
  suffix: string,
  options: { withoutKey?: boolean } = {},
) => {
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  if (!options.withoutKey) await grantLlmKey(agent.id, suffix);
  return agent.id;
};

/** JSON of a stored org automation credential, encrypted the way the
 * services store it. `expiresIn` positions it against the rotate window. */
const integrationCredentials = async (expiresIn: number) =>
  getCrypto().encrypt(
    JSON.stringify({
      accessToken: "xoxe.access-stored",
      refreshToken: "xoxe-refresh-stored",
      expiresAt: nowSec() + expiresIn,
    }),
  );

const seedIntegration = async (
  options: {
    organizationId?: string;
    externalId?: string;
    credentials?: string | null;
    rotatedAt?: Date | null;
  } = {},
) =>
  db.channelIntegration.create({
    data: {
      organizationId: options.organizationId ?? ORG,
      provider: "slack",
      externalId: options.externalId ?? "T111",
      name: "Acme",
      credentials: options.credentials ?? null,
      credentialsRotatedAt:
        options.rotatedAt === undefined
          ? options.credentials
            ? new Date()
            : null
          : options.rotatedAt,
      createdByUserId: ADMIN,
    },
    select: { id: true, externalId: true },
  });

/** An active presence wired straight into the DB — the ingestion/adapter
 * suites' starting state, without walking the attach flow each time. */
const seedPresence = async (
  agentId: string,
  integrationId: string,
  options: {
    status?: string;
    identityRef?: string | null;
    credentials?: string | null;
    externalId?: string;
    apiKeyId?: string | null;
    appMode?: string;
  } = {},
) =>
  db.agentChannel.create({
    data: {
      agentId,
      integrationId,
      provider: "slack",
      externalId: options.externalId ?? `A-${agentId.slice(0, 8)}`,
      identityRef:
        options.identityRef === undefined ? "UBOT" : options.identityRef,
      transport: "socket",
      appMode: options.appMode ?? "regular",
      status: options.status ?? "active",
      credentials: options.credentials ?? null,
      apiKeyId: options.apiKeyId ?? null,
      createdByUserId: ADMIN,
    },
    select: { id: true, externalId: true },
  });

const linkUser = (
  integrationId: string,
  externalUserId: string,
  userId: string,
) =>
  db.channelUserLink.create({
    data: { integrationId, externalUserId, userId, linkedVia: "manual" },
    select: { id: true },
  });

/**
 * Settle a channel so the IDENTITY lane can be exercised.
 *
 * A channel's reach grant is a PRECONDITION (agent-reach-service): until a
 * human settles it, the agent answers nobody there - member or stranger.
 * These group-surface arms are about identity, not about reach, so they
 * settle the channel to `members_only` (the historical behavior they were
 * written against) and then assert on the lane they actually test.
 */
const settleChannel = (
  agentId: string,
  integrationId: string,
  externalRef: string,
) =>
  db.agentReachGrant.create({
    data: {
      agentId,
      integrationId,
      provider: "slack",
      subjectKind: "space",
      externalRef,
      state: "members_only",
      promptRefs: [],
    },
    select: { id: true },
  });

/** A channel-ready agent: hosted agent + org integration + active presence. */
const seedChannelAgent = async (
  suffix: string,
  options: {
    withoutKey?: boolean;
    identityRef?: string | null;
    presenceCredentials?: string | null;
    appMode?: string;
  } = {},
) => {
  const agentId = await seedAgent(suffix, { withoutKey: options.withoutKey });
  const integration = await db.channelIntegration.upsert({
    where: {
      organizationId_provider: { organizationId: ORG, provider: "slack" },
    },
    create: {
      organizationId: ORG,
      provider: "slack",
      externalId: "T111",
      name: "Acme",
      createdByUserId: ADMIN,
    },
    update: {},
    select: { id: true },
  });
  const presence = await seedPresence(agentId, integration.id, {
    identityRef: options.identityRef,
    credentials: options.presenceCredentials,
    externalId: `A-${suffix}`,
    appMode: options.appMode,
  });
  return { agentId, integrationId: integration.id, presenceId: presence.id };
};

const dmEvent = (user: string, channel: string, text: string) => ({
  type: "message",
  channel,
  channel_type: "im",
  user,
  text,
  ts: "1000.0001",
});

const mentionEvent = (
  user: string,
  channel: string,
  ts: string,
  text: string,
) => ({ type: "app_mention", channel, user, text, ts });

beforeAll(async () => {
  if (!PROOF_URL) return;

  // Fakes first: their addresses feed env vars read at module load below.
  const slackUrl = await startSlackFake();
  const cdnUrl = await startCdnFake();
  const gatewayUrl = await startGatewayFake();

  process.env.DATABASE_URL = PROOF_URL;
  // Pin the edition BEFORE any dynamic import below loads `lib/env`: this
  // suite's assertions are onprem semantics (factory AES crypto, flat-team
  // access — no roleResolver). Vitest isolates the module graph per file but
  // `process.env` LEAKS across files in a reused worker, so without this pin
  // the suite inherits whatever edition the previous file left behind —
  // green or red by scheduling (CI's ambient NEXT_PUBLIC_EDITION is cloud).
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.CHANNEL_ADAPTER_TOKEN = ADAPTER_ANCHOR;
  process.env.GATEWAY_INTERNAL_URL = gatewayUrl;
  process.env.SLACK_API_BASE_URL = slackUrl;
  process.env.SLACK_CDN_BASE_URL = cdnUrl;
  // The reaction chooser's inference calls land on the SAME recording fake
  // (an unscripted method answers ok:false → the chooser falls back to
  // "eyes") — a pg test must never reach a real model origin.
  process.env.ANTHROPIC_API_BASE_URL = slackUrl;
  process.env.OPENAI_API_BASE_URL = slackUrl;

  ({ db } = await import("@onecli/db"));
  integrations = await import("./channel-integration-service");
  agentChannels = await import("./agent-channel-service");
  ingestion = await import("./channel-ingestion-service");
  adapters = await import("./channel-adapter-service");
  approvals = await import("./channel-approval-service");
  dispatch = await import("./providers/slack/dispatch");
  apiKeys = await import("../api-key-service");
  receipts = await import("./turn-receipt-service");
  validations = await import("../../validations/conversation");
  decryptCache = await import("./channel-decrypt-cache");
  ({ getCrypto, initSelfUrl, initAttachmentStore } =
    await import("../../providers"));
  // This suite imports services directly (never createApiApp), so
  // ensureEditionDefaults() has not injected the attachment blob store — the
  // file-share tests need it. The inline-Postgres store is the both-edition
  // default; inject it explicitly here.
  const { pgAttachmentBlobStore } =
    await import("../attachments/pg-blob-store");
  initAttachmentStore(pgAttachmentBlobStore);

  await dropAll();
  await db.organization.createMany({
    data: [
      { id: ORG, name: ORG, slug: ORG },
      { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
    ],
  });
  await db.workspace.createMany({
    data: [
      { id: WORKSPACE, name: "Channels Workspace", organizationId: ORG },
      { id: OTHER_WORKSPACE, name: "Elsewhere", organizationId: OTHER_ORG },
    ],
  });
  await db.user.createMany({
    data: [
      { id: ADMIN, email: `${ADMIN}@example.com`, externalAuthId: ADMIN },
      {
        id: MEMBER,
        email: `${MEMBER}@example.com`,
        externalAuthId: MEMBER,
        name: "Morgan Member",
      },
      {
        id: OUTSIDER,
        email: `${OUTSIDER}@example.com`,
        externalAuthId: OUTSIDER,
      },
      {
        id: SUSPENDED,
        email: `${SUSPENDED}@example.com`,
        externalAuthId: SUSPENDED,
      },
      {
        id: CTRL_NAME_USER,
        email: `${CTRL_NAME_USER}@example.com`,
        externalAuthId: CTRL_NAME_USER,
        // Control characters on purpose — the speaker-prefix sanitizer's prey.
        name: `Bad${String.fromCharCode(7)}Name${String.fromCharCode(27)}`,
      },
    ],
  });
  await db.organizationMember.createMany({
    data: [
      {
        organizationId: ORG,
        userId: ADMIN,
        userEmail: `${ADMIN}@example.com`,
        role: "owner",
      },
      {
        organizationId: ORG,
        userId: MEMBER,
        userEmail: `${MEMBER}@example.com`,
        role: "member",
      },
      {
        organizationId: ORG,
        userId: CTRL_NAME_USER,
        userEmail: `${CTRL_NAME_USER}@example.com`,
        role: "member",
      },
      {
        organizationId: ORG,
        userId: SUSPENDED,
        userEmail: `${SUSPENDED}@example.com`,
        role: "member",
        status: "suspended",
        suspendedAt: new Date(),
      },
    ],
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
  // Ciphertexts repeat across tests (deterministic fake crypto), so a stale
  // cache entry would make decrypt-count assertions vacuous.
  decryptCache.resetDecryptCacheForTests();
  slackCalls = [];
  slackHandlers = {};
  cdnCalls = [];
  cdnHandlers = {};
  gatewayCalls = [];
  gatewayRespond = () => ({ status: 200, body: { success: true } });
  // Default posture: no public HTTPS → socket. Events tests opt in.
  initSelfUrl(SOCKET_SELF_URL);
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await dropAll();
  await db.$disconnect();
  await new Promise((resolve) => slackServer.close(resolve));
  await new Promise((resolve) => cdnServer.close(resolve));
  await new Promise((resolve) => gatewayServer.close(resolve));
});

// ── The integration service ─────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("integration service — connect", () => {
  it("connects by ROTATING the pasted token, storing the fresh pair encrypted", async () => {
    const exp = nowSec() + 12 * 3600;
    slackHandlers["tooling.tokens.rotate"] = () => ({
      ok: true,
      token: "xoxe.access-1",
      refresh_token: "xoxe-refresh-1",
      team_id: "T111",
      exp,
    });

    const result = await integrations.connectIntegration(
      ORG,
      "slack",
      "xoxe-pasted-refresh",
      ADMIN,
    );

    expect(result.tenant.externalId).toBe("T111");
    // The rotate consumed the PASTED token — that is the validation.
    expect(slackCallsFor("tooling.tokens.rotate")).toHaveLength(1);
    expect(
      slackCallsFor("tooling.tokens.rotate")[0]?.form.get("refresh_token"),
    ).toBe("xoxe-pasted-refresh");

    const row = await db.channelIntegration.findUniqueOrThrow({
      where: {
        organizationId_provider: { organizationId: ORG, provider: "slack" },
      },
    });
    expect(row.externalId).toBe("T111");
    expect(row.credentialsRotatedAt).not.toBeNull();
    expect(row.credentials).not.toBeNull();
    // Encrypted at rest: the raw column must not contain the token...
    expect(row.credentials).not.toContain("xoxe.access-1");
    // ...and decrypting yields the FRESH pair, never the pasted one.
    expect(JSON.parse(await getCrypto().decrypt(row.credentials!))).toEqual({
      accessToken: "xoxe.access-1",
      refreshToken: "xoxe-refresh-1",
      expiresAt: exp,
    });
  });

  it("refuses a paste that is not an xoxe token, without calling Slack", async () => {
    await expect(
      integrations.connectIntegration(ORG, "slack", "xoxb-a-bot-token", ADMIN),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    expect(slackCalls).toHaveLength(0);
  });

  it("REFUSES re-connecting a DIFFERENT workspace while presences live on the old one", async () => {
    const integration = await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("rebind-guard");
    await seedPresence(agentId, integration.id);

    slackHandlers["tooling.tokens.rotate"] = () => ({
      ok: true,
      token: "xoxe.other",
      refresh_token: "xoxe-other",
      team_id: "T222", // a different workspace
      exp: nowSec() + 12 * 3600,
    });

    await expect(
      integrations.connectIntegration(ORG, "slack", "xoxe-paste", ADMIN),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // And the old binding is untouched.
    const row = await db.channelIntegration.findUniqueOrThrow({
      where: { id: integration.id },
    });
    expect(row.externalId).toBe("T111");
  });

  it("rebinds to a different workspace when NO presences depend on it", async () => {
    await seedIntegration({});
    slackHandlers["tooling.tokens.rotate"] = () => ({
      ok: true,
      token: "xoxe.other",
      refresh_token: "xoxe-other",
      team_id: "T222",
      exp: nowSec() + 12 * 3600,
    });

    const result = await integrations.connectIntegration(
      ORG,
      "slack",
      "xoxe-paste",
      ADMIN,
    );

    expect(result.tenant.externalId).toBe("T222");
    const row = await db.channelIntegration.findUniqueOrThrow({
      where: {
        organizationId_provider: { organizationId: ORG, provider: "slack" },
      },
    });
    expect(row.externalId).toBe("T222");
  });
});

describe.skipIf(!PROOF_URL)("integration service — app flavor", () => {
  it("the guided create stamps agent and bakes agent_view + assistant:write into the manifest", async () => {
    // NEW apps are always agent-flavored — there is no org setting anymore.
    // The stamp on the row is what the runtime honors (loader vs emoji), and
    // pre-existing "regular" rows keep theirs.
    await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("stamp-agent");
    scriptManifestCreate();

    const result = await agentChannels.createPresence(
      WORKSPACE,
      agentId,
      "slack",
      ADMIN,
    );

    const row = await db.agentChannel.findUniqueOrThrow({
      where: { id: result.presenceId },
    });
    expect(row.appMode).toBe("agent");
    const manifest = JSON.parse(
      slackCallsFor("apps.manifest.create").at(-1)!.form.get("manifest")!,
    ) as {
      features: { agent_view?: { agent_description: string } };
      oauth_config: { scopes: { bot: string[] } };
    };
    expect(manifest.features.agent_view?.agent_description).toContain(
      "a OneCLI hosted agent",
    );
    expect(manifest.oauth_config.scopes.bot).toContain("assistant:write");
  });
});

describe.skipIf(!PROOF_URL)("integration service — disconnect", () => {
  it("keeps the row (credential cleared) while presences reference it", async () => {
    const integration = await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("disc-presences");
    await seedPresence(agentId, integration.id);

    await integrations.disconnectIntegration(ORG, "slack");

    const row = await db.channelIntegration.findUnique({
      where: { id: integration.id },
    });
    expect(row).not.toBeNull();
    expect(row?.credentials).toBeNull();
  });

  it("reads as ABSENCE, not failure — a deliberate disconnect must not raise the needs-token alarm", async () => {
    // OBSERVED LIVE: disconnect used to leave `credentialsRotatedAt` set,
    // which is the exact signature `needsCredentials` reads as "the token
    // expired" — so the console reported a failure the admin had chosen.
    const integration = await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("disc-absence");
    await seedPresence(agentId, integration.id);

    await integrations.disconnectIntegration(ORG, "slack");

    const row = await db.channelIntegration.findUnique({
      where: { id: integration.id },
      select: { credentialsRotatedAt: true },
    });
    expect(row?.credentialsRotatedAt).toBeNull();

    const [view] = await integrations.getIntegrationView(ORG);
    expect(view).toMatchObject({
      hasCredentials: false,
      needsCredentials: false,
    });
  });

  it("deletes the row entirely when nothing references it", async () => {
    const integration = await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });

    await integrations.disconnectIntegration(ORG, "slack");

    expect(
      await db.channelIntegration.findUnique({ where: { id: integration.id } }),
    ).toBeNull();
  });

  it("answers NOT_FOUND for an org with no integration", async () => {
    await expect(
      integrations.disconnectIntegration(ORG, "slack"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe.skipIf(!PROOF_URL)("withFreshIntegrationCredentials", () => {
  it("uses a FRESH stored token as-is — no rotate call", async () => {
    await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });

    const seen: string[] = [];
    await integrations.withFreshIntegrationCredentials(
      ORG,
      "slack",
      async (accessToken) => {
        seen.push(accessToken);
      },
    );

    expect(seen).toEqual(["xoxe.access-stored"]);
    expect(slackCallsFor("tooling.tokens.rotate")).toHaveLength(0);
  });

  it("rotates NEAR expiry and persists the new pair BEFORE running fn", async () => {
    const integration = await seedIntegration({
      credentials: await integrationCredentials(60), // inside the 10min window
      rotatedAt: new Date(Date.now() - 3600_000),
    });
    const exp = nowSec() + 12 * 3600;
    slackHandlers["tooling.tokens.rotate"] = () => ({
      ok: true,
      token: "xoxe.access-2",
      refresh_token: "xoxe-refresh-2",
      team_id: "T111",
      exp,
    });
    const before = await db.channelIntegration.findUniqueOrThrow({
      where: { id: integration.id },
      select: { credentialsRotatedAt: true },
    });

    let persistedDuringFn: unknown;
    const got = await integrations.withFreshIntegrationCredentials(
      ORG,
      "slack",
      async (accessToken) => {
        // The refresh half is single-use: by the time fn runs, the NEW pair
        // must already be on disk — a crash here must not strand the org
        // with a consumed refresh token it never stored.
        const row = await db.channelIntegration.findUniqueOrThrow({
          where: { id: integration.id },
        });
        persistedDuringFn = JSON.parse(
          await getCrypto().decrypt(row.credentials!),
        );
        return accessToken;
      },
    );

    expect(got).toBe("xoxe.access-2");
    expect(slackCallsFor("tooling.tokens.rotate")).toHaveLength(1);
    // The old (consumed) pair was rotated out in the SAME update that moved
    // credentialsRotatedAt — assert both halves landed together.
    expect(persistedDuringFn).toEqual({
      accessToken: "xoxe.access-2",
      refreshToken: "xoxe-refresh-2",
      expiresAt: exp,
    });
    const after = await db.channelIntegration.findUniqueOrThrow({
      where: { id: integration.id },
      select: { credentialsRotatedAt: true },
    });
    expect(after.credentialsRotatedAt!.getTime()).toBeGreaterThan(
      before.credentialsRotatedAt!.getTime(),
    );
  });

  it("a REFUSED rotation clears the credential and surfaces the re-paste state", async () => {
    await seedIntegration({
      credentials: await integrationCredentials(60),
      rotatedAt: new Date(),
    });
    slackHandlers["tooling.tokens.rotate"] = () => ({
      ok: false,
      error: "invalid_refresh_token",
    });

    await expect(
      integrations.withFreshIntegrationCredentials(ORG, "slack", async () => 1),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });

    // The needs-token derivation: connected once (rotatedAt set) but the
    // credential is now gone → hasCredentials false + needsCredentials true.
    const [view] = await integrations.getIntegrationView(ORG);
    expect(view).toMatchObject({
      hasCredentials: false,
      needsCredentials: true,
    });
    expect(view?.credentialsRotatedAt).not.toBeNull();
  });

  it("a stale REFUSAL does not wipe a credential a concurrent rotate already replaced (the fence)", async () => {
    // The clear-for-re-paste is fenced on the ciphertext we READ
    // (updateMany WHERE credentials = storedCiphertext). MUTATION-TESTED: revert
    // it to `update WHERE { id }` and the loser's stale refusal destroys the
    // winner's still-good pair. Here the concurrent winner is simulated INSIDE
    // the rotate handler — it lands a fresh ciphertext, then refuses our rotate
    // (Slack refresh tokens are single-use) — so by the time our fenced clear
    // runs the stored ciphertext no longer matches and nothing is wiped.
    const integration = await seedIntegration({
      credentials: await integrationCredentials(60), // inside the rotate window
      rotatedAt: new Date(),
    });
    const winnerCiphertext = await integrationCredentials(12 * 3600);

    slackHandlers["tooling.tokens.rotate"] = async () => {
      await db.channelIntegration.update({
        where: { id: integration.id },
        data: {
          credentials: winnerCiphertext,
          credentialsRotatedAt: new Date(),
        },
      });
      return { ok: false, error: "invalid_refresh_token" };
    };

    await expect(
      integrations.withFreshIntegrationCredentials(ORG, "slack", async () => 1),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });

    // The winner's fresh credential SURVIVES — the fenced clear matched nothing.
    const row = await db.channelIntegration.findUniqueOrThrow({
      where: { id: integration.id },
    });
    expect(row.credentials).toBe(winnerCiphertext);
    expect(row.credentials).not.toBeNull();
  });

  it("a rotation naming a DIFFERENT workspace is refused — the foreign pair never lands, the credential clears", async () => {
    // MUTATION-TESTED (the rotation arm of the tenant fence): drop the
    // externalId comparison in withFreshIntegrationCredentials and a swapped
    // stored credential quietly becomes a FOREIGN workspace's automation
    // token — every manifest-created agent app would land in that workspace
    // while the row still claims the connected one.
    const integration = await seedIntegration({
      credentials: await integrationCredentials(60), // inside the rotate window
      rotatedAt: new Date(),
    });
    slackHandlers["tooling.tokens.rotate"] = () => ({
      ok: true,
      token: "xoxe.access-foreign",
      refresh_token: "xoxe-refresh-foreign",
      team_id: "T999",
      exp: nowSec() + 12 * 3600,
    });

    let ran = false;
    await expect(
      integrations.withFreshIntegrationCredentials(ORG, "slack", async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // fn never saw the foreign token.
    expect(ran).toBe(false);

    const row = await db.channelIntegration.findUniqueOrThrow({
      where: { id: integration.id },
    });
    // Cleared for re-paste — the foreign pair is NOT on disk — and the
    // stored tenant binding never moved.
    expect(row.credentials).toBeNull();
    expect(row.externalId).toBe("T111");
    // Same alarm state as a dead pair: connected once, token now gone.
    const [view] = await integrations.getIntegrationView(ORG);
    expect(view).toMatchObject({
      hasCredentials: false,
      needsCredentials: true,
    });
  });

  it("a paste-floor integration (never had a credential) reads absence, not failure", async () => {
    await seedIntegration({ credentials: null, rotatedAt: null });

    await expect(
      integrations.withFreshIntegrationCredentials(ORG, "slack", async () => 1),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });

    const [view] = await integrations.getIntegrationView(ORG);
    expect(view).toMatchObject({
      hasCredentials: false,
      needsCredentials: false,
    });
  });
});

describe.skipIf(!PROOF_URL)(
  "rotateStaleIntegrations (the proactive sweep)",
  () => {
    const SEVEN_HOURS_AGO = () => new Date(Date.now() - 7 * 3600_000);

    it("FORCE-rotates a fresh-but-old credential (rotatedAt ~7h ago) and persists the new pair", async () => {
      // The sweep exists because an UNUSED refresh token's lifetime is
      // undocumented on Slack's side: this credential's access token is a full
      // 12h from expiry — the lazy rotate-on-use path would not touch it — yet
      // it has sat unrotated for 7h. MUTATION-TESTED: drop `force: true` from
      // the sweep's rotateIntegrationCredential call and the provider's
      // freshness check skips this row; the fake's hit count and the persisted
      // pair both catch it.
      const integration = await seedIntegration({
        credentials: await integrationCredentials(12 * 3600), // fresh access token
        rotatedAt: SEVEN_HOURS_AGO(), // but past the ~6h sweep cutoff
      });
      const exp = nowSec() + 12 * 3600;
      slackHandlers["tooling.tokens.rotate"] = () => ({
        ok: true,
        token: "xoxe.access-swept",
        refresh_token: "xoxe-refresh-swept",
        team_id: "T111",
        exp,
      });
      const sweepStart = Date.now();

      const result = await integrations.rotateStaleIntegrations();

      expect(result).toEqual({ rotated: 1, failed: 0 });
      // The rotate consumed the STORED refresh token…
      const rotateCalls = slackCallsFor("tooling.tokens.rotate");
      expect(rotateCalls).toHaveLength(1);
      expect(rotateCalls[0]?.form.get("refresh_token")).toBe(
        "xoxe-refresh-stored",
      );
      // …and the fresh pair landed, with rotatedAt advanced past the sweep.
      const row = await db.channelIntegration.findUniqueOrThrow({
        where: { id: integration.id },
      });
      expect(JSON.parse(await getCrypto().decrypt(row.credentials!))).toEqual({
        accessToken: "xoxe.access-swept",
        refreshToken: "xoxe-refresh-swept",
        expiresAt: exp,
      });
      expect(row.credentialsRotatedAt!.getTime()).toBeGreaterThanOrEqual(
        sweepStart,
      );
    });

    it("leaves a RECENTLY rotated credential alone — no Slack call, no write", async () => {
      const integration = await seedIntegration({
        credentials: await integrationCredentials(12 * 3600),
        rotatedAt: new Date(),
      });
      const before = await db.channelIntegration.findUniqueOrThrow({
        where: { id: integration.id },
        select: { credentials: true, credentialsRotatedAt: true },
      });

      const result = await integrations.rotateStaleIntegrations();

      expect(result).toEqual({ rotated: 0, failed: 0 });
      expect(slackCallsFor("tooling.tokens.rotate")).toHaveLength(0);
      const after = await db.channelIntegration.findUniqueOrThrow({
        where: { id: integration.id },
        select: { credentials: true, credentialsRotatedAt: true },
      });
      expect(after.credentials).toBe(before.credentials);
      expect(after.credentialsRotatedAt).toEqual(before.credentialsRotatedAt);
    });

    it("a REFUSED sweep rotation clears the credential and counts failed — re-paste surfaces", async () => {
      const integration = await seedIntegration({
        credentials: await integrationCredentials(12 * 3600),
        rotatedAt: SEVEN_HOURS_AGO(),
      });
      slackHandlers["tooling.tokens.rotate"] = () => ({
        ok: false,
        error: "invalid_refresh_token",
      });

      const result = await integrations.rotateStaleIntegrations();

      expect(result).toEqual({ rotated: 0, failed: 1 });
      const row = await db.channelIntegration.findUniqueOrThrow({
        where: { id: integration.id },
        select: { credentials: true },
      });
      expect(row.credentials).toBeNull();
      // The needs-token derivation: rotatedAt still set + credentials gone.
      const [view] = await integrations.getIntegrationView(ORG);
      expect(view).toMatchObject({
        hasCredentials: false,
        needsCredentials: true,
      });
    });

    it("the sweep refuses a rotation naming a different workspace — cleared and counted failed", async () => {
      // MUTATION-TESTED (the sweep arm of the tenant fence): drop the
      // externalId comparison in rotateStaleIntegrations and the sweep
      // persists the foreign pair as the org's automation credential
      // (`rotated: 1`, ciphertext replaced) with no one ever using the org
      // page to notice.
      const integration = await seedIntegration({
        credentials: await integrationCredentials(12 * 3600),
        rotatedAt: SEVEN_HOURS_AGO(),
      });
      slackHandlers["tooling.tokens.rotate"] = () => ({
        ok: true,
        token: "xoxe.access-foreign",
        refresh_token: "xoxe-refresh-foreign",
        team_id: "T999",
        exp: nowSec() + 12 * 3600,
      });

      const result = await integrations.rotateStaleIntegrations();

      expect(result).toEqual({ rotated: 0, failed: 1 });
      const row = await db.channelIntegration.findUniqueOrThrow({
        where: { id: integration.id },
      });
      // Cleared for re-paste, never rebound.
      expect(row.credentials).toBeNull();
      expect(row.externalId).toBe("T111");
    });

    it("a refused SWEEP rotation cannot wipe a pair a concurrent rotate already replaced (the fence)", async () => {
      // Same fence law as withFreshIntegrationCredentials, on the sweep's own
      // clear: it is fenced on the ciphertext the sweep READ. MUTATION-TESTED:
      // drop `credentials: row.credentials` from the sweep's clear WHERE and
      // the loser's stale refusal destroys the winner's still-good pair —
      // exactly the torn state the fence exists to prevent.
      const integration = await seedIntegration({
        credentials: await integrationCredentials(12 * 3600),
        rotatedAt: SEVEN_HOURS_AGO(),
      });
      const winnerCiphertext = await integrationCredentials(12 * 3600);
      slackHandlers["tooling.tokens.rotate"] = async () => {
        // The concurrent winner lands a fresh pair BEFORE our rotate refuses
        // (Slack refresh tokens are single-use — the loser always refuses).
        await db.channelIntegration.update({
          where: { id: integration.id },
          data: {
            credentials: winnerCiphertext,
            credentialsRotatedAt: new Date(),
          },
        });
        return { ok: false, error: "invalid_refresh_token" };
      };

      const result = await integrations.rotateStaleIntegrations();

      expect(result).toEqual({ rotated: 0, failed: 1 });
      const row = await db.channelIntegration.findUniqueOrThrow({
        where: { id: integration.id },
        select: { credentials: true },
      });
      expect(row.credentials).toBe(winnerCiphertext);
      expect(row.credentials).not.toBeNull();
    });
  },
);

describe.skipIf(!PROOF_URL)(
  "rotation single-flight (the rotate lock + sweep claims)",
  () => {
    it("a rotate BLOCKED behind the lock re-reads the winner's pair and never calls Slack", async () => {
      // The verified N-instance breakage this design kills: without the lock
      // (and the in-lock re-read) the loser's rotate consumes a single-use
      // refresh token, gets refused, and its fenced clear can null the
      // winner's still-good pair. MUTATION-TESTED: delete the in-lock re-read
      // (always rotate from the pre-lock snapshot) and the loser here calls
      // the unscripted rotate → SlackApiError; delete the lock and the loser
      // races ahead of the winner's commit with the same result.
      const integration = await seedIntegration({
        credentials: await integrationCredentials(60), // inside the rotate window
        rotatedAt: new Date(),
      });
      const winnerCiphertext = await getCrypto().encrypt(
        JSON.stringify({
          accessToken: "xoxe.access-winner",
          refreshToken: "xoxe-refresh-winner",
          expiresAt: nowSec() + 12 * 3600,
        }),
      );
      // No rotate handler on purpose: ANY tooling.tokens.rotate call in this
      // test answers test_unscripted and fails the run loudly.

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let lockTaken!: () => void;
      const taken = new Promise<void>((resolve) => (lockTaken = resolve));
      const winner = db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel-integration-rotate:${integration.id}`}))`;
          await tx.channelIntegration.update({
            where: { id: integration.id },
            data: {
              credentials: winnerCiphertext,
              credentialsRotatedAt: new Date(),
            },
          });
          lockTaken();
          await gate;
        },
        { timeout: 15_000 },
      );
      await taken;

      const loser = integrations.withFreshIntegrationCredentials(
        ORG,
        "slack",
        async (accessToken) => accessToken,
      );
      // The loser is parked on the advisory lock; nothing has hit Slack.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(slackCallsFor("tooling.tokens.rotate")).toHaveLength(0);

      release();
      await winner;

      // Unblocked, it re-reads the winner's FRESH pair, skips the rotate
      // entirely, and hands fn the winner's access token.
      expect(await loser).toBe("xoxe.access-winner");
      expect(slackCallsFor("tooling.tokens.rotate")).toHaveLength(0);
      const row = await db.channelIntegration.findUniqueOrThrow({
        where: { id: integration.id },
      });
      expect(row.credentials).toBe(winnerCiphertext);
    });

    it("the sweep's claim lease makes concurrent sweeps rotate each row AT MOST once", async () => {
      const integration = await seedIntegration({
        credentials: await integrationCredentials(12 * 3600),
        rotatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000), // stale (>6h)
      });
      slackHandlers["tooling.tokens.rotate"] = () => ({
        ok: true,
        token: "xoxe.access-swept",
        refresh_token: "xoxe-refresh-swept",
        team_id: "T111",
        exp: nowSec() + 12 * 3600,
      });

      const [first, second] = await Promise.all([
        integrations.rotateStaleIntegrations(),
        integrations.rotateStaleIntegrations(),
      ]);

      // One rotation total — Slack's refresh half is single-use, so a second
      // attempt anywhere would have consumed a dead token and bricked the row.
      expect(slackCallsFor("tooling.tokens.rotate")).toHaveLength(1);
      expect(first.rotated + second.rotated).toBe(1);
      expect(first.failed + second.failed).toBe(0);
      const row = await db.channelIntegration.findUniqueOrThrow({
        where: { id: integration.id },
      });
      expect(row.credentials).not.toBeNull();
    });

    it("a FRESH claim lease parks the row; an expired one is re-claimable", async () => {
      // MUTATION-TESTED (the rotate_claimed_at arm of the claim CTE): drop it
      // and the freshly-claimed row below is swept again immediately — the
      // crashed-claimer retry window collapses to zero.
      const integration = await seedIntegration({
        credentials: await integrationCredentials(12 * 3600),
        rotatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
      });
      slackHandlers["tooling.tokens.rotate"] = () => ({
        ok: true,
        token: "xoxe.access-reclaim",
        refresh_token: "xoxe-refresh-reclaim",
        team_id: "T111",
        exp: nowSec() + 12 * 3600,
      });

      // A peer claimed it moments ago (and hasn't finished): hands off.
      await db.channelIntegration.update({
        where: { id: integration.id },
        data: { rotateClaimedAt: new Date() },
      });
      expect(await integrations.rotateStaleIntegrations()).toEqual({
        rotated: 0,
        failed: 0,
      });
      expect(slackCallsFor("tooling.tokens.rotate")).toHaveLength(0);

      // The claimer crashed: its lease ages out and the row is swept.
      await db.channelIntegration.update({
        where: { id: integration.id },
        data: { rotateClaimedAt: new Date(Date.now() - 11 * 60 * 1000) },
      });
      expect(await integrations.rotateStaleIntegrations()).toEqual({
        rotated: 1,
        failed: 0,
      });
      expect(slackCallsFor("tooling.tokens.rotate")).toHaveLength(1);
    });

    it("count-0 reconcile: an unlocked writer's PASTE wins; its stale CLEAR is recovered from", async () => {
      // The tripwire for a writer that bypasses the lock. MUTATION-TESTED:
      // delete the `count === 0` reconcile branch and the recover arm below
      // leaves the row NULL — the freshly minted pair is lost and the org is
      // told to re-paste for nothing.
      const rotateSuccess = {
        ok: true,
        token: "xoxe.access-rotated",
        refresh_token: "xoxe-refresh-rotated",
        team_id: "T111",
        exp: nowSec() + 12 * 3600,
      };

      // Arm 1 — a newer paste lands mid-rotation: it wins, never clobbered.
      const pasted = await seedIntegration({
        credentials: await integrationCredentials(60),
        rotatedAt: new Date(),
      });
      const pasteCiphertext = await getCrypto().encrypt(
        JSON.stringify({
          accessToken: "xoxe.access-pasted",
          refreshToken: "xoxe-refresh-pasted",
          expiresAt: nowSec() + 12 * 3600,
        }),
      );
      slackHandlers["tooling.tokens.rotate"] = async () => {
        await db.channelIntegration.update({
          where: { id: pasted.id },
          data: {
            credentials: pasteCiphertext,
            credentialsRotatedAt: new Date(),
          },
        });
        return rotateSuccess;
      };
      await integrations.withFreshIntegrationCredentials(
        ORG,
        "slack",
        async () => 1,
      );
      expect(
        (
          await db.channelIntegration.findUniqueOrThrow({
            where: { id: pasted.id },
          })
        ).credentials,
      ).toBe(pasteCiphertext);
      await db.channelIntegration.delete({ where: { id: pasted.id } });

      // Arm 2 — a stale unlocked CLEAR nulls the row mid-rotation: the fresh
      // pair is recovered (fenced on null, so a simultaneous paste still wins).
      const cleared = await seedIntegration({
        credentials: await integrationCredentials(60),
        rotatedAt: new Date(),
      });
      slackHandlers["tooling.tokens.rotate"] = async () => {
        await db.channelIntegration.update({
          where: { id: cleared.id },
          data: { credentials: null },
        });
        return rotateSuccess;
      };
      const accessToken = await integrations.withFreshIntegrationCredentials(
        ORG,
        "slack",
        async (token) => token,
      );
      expect(accessToken).toBe("xoxe.access-rotated");
      const recovered = await db.channelIntegration.findUniqueOrThrow({
        where: { id: cleared.id },
      });
      expect(recovered.credentials).not.toBeNull();
      expect(await getCrypto().decrypt(recovered.credentials!)).toContain(
        "xoxe.access-rotated",
      );
    });

    it("a DISCONNECT-shaped clear (both columns nulled) is a revocation — never recovered over", async () => {
      // MUTATION-TESTED (the reconcile's credentialsRotatedAt discriminator):
      // drop `credentialsRotatedAt: { not: null }` from the recover arm and
      // the rotation below writes its freshly rotated LIVE pair back over the
      // admin's revocation — the org page silently shows connected again.
      const integration = await seedIntegration({
        credentials: await integrationCredentials(60),
        rotatedAt: new Date(),
      });
      slackHandlers["tooling.tokens.rotate"] = async () => {
        // An unlocked writer lands a disconnect: BOTH columns nulled.
        await db.channelIntegration.update({
          where: { id: integration.id },
          data: { credentials: null, credentialsRotatedAt: null },
        });
        return {
          ok: true,
          token: "xoxe.access-zombie",
          refresh_token: "xoxe-refresh-zombie",
          team_id: "T111",
          exp: nowSec() + 12 * 3600,
        };
      };

      await integrations.withFreshIntegrationCredentials(
        ORG,
        "slack",
        async () => 1,
      );
      const row = await db.channelIntegration.findUniqueOrThrow({
        where: { id: integration.id },
      });
      expect(row.credentials).toBeNull();
      expect(row.credentialsRotatedAt).toBeNull();
    });

    it("disconnectIntegration SERIALIZES behind an in-flight rotation — the revocation lands last and stands", async () => {
      // MUTATION-TESTED (the rotate lock on the disconnect path): drop
      // `withIntegrationRotateLock` from disconnectIntegration and the
      // disconnect below settles while the rotation still holds the lock.
      const integration = await seedIntegration({
        credentials: await integrationCredentials(60),
        rotatedAt: new Date(),
      });
      // An attached presence keeps the row alive on disconnect (the CLEAR
      // branch — the resurrect-prone one), not the delete branch.
      await seedPresence(await seedAgent("disc-lock"), integration.id, {
        externalId: "A-disc-lock",
      });

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let rotating!: () => void;
      const started = new Promise<void>((resolve) => (rotating = resolve));
      slackHandlers["tooling.tokens.rotate"] = async () => {
        rotating();
        await gate; // hold the rotation (and its lock) open
        return {
          ok: true,
          token: "xoxe.access-slow",
          refresh_token: "xoxe-refresh-slow",
          team_id: "T111",
          exp: nowSec() + 12 * 3600,
        };
      };

      const rotation = integrations.withFreshIntegrationCredentials(
        ORG,
        "slack",
        async () => 1,
      );
      await started;

      let disconnected = false;
      const disconnect = integrations
        .disconnectIntegration(ORG, "slack")
        .then(() => {
          disconnected = true;
        });
      // Parked on the lock while the rotation is mid-Slack-call.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(disconnected).toBe(false);

      release();
      await rotation;
      await disconnect;

      // The revocation was the LAST write and it stands.
      const row = await db.channelIntegration.findUniqueOrThrow({
        where: { id: integration.id },
      });
      expect(row.credentials).toBeNull();
      expect(row.credentialsRotatedAt).toBeNull();
    });
  },
);

describe.skipIf(!PROOF_URL)("user links", () => {
  it("links an active member", async () => {
    await seedIntegration({});
    const link = await integrations.addUserLink(ORG, "slack", {
      externalUserId: "U100",
      userId: MEMBER,
    });
    expect(link.user.id).toBe(MEMBER);
    expect(link.linkedVia).toBe("manual");
  });

  it("REFUSES linking a user who is not a member of the org", async () => {
    // MUTATION-TESTED: a link is an authorization input — delete the
    // membership check in addUserLink and this test fails, meaning any User
    // row in the database could be granted a Slack identity into this org.
    await seedIntegration({});
    await expect(
      integrations.addUserLink(ORG, "slack", {
        externalUserId: "U100",
        userId: OUTSIDER,
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    expect(
      await db.channelUserLink.count({
        where: { integration: { organizationId: ORG } },
      }),
    ).toBe(0);
  });

  it("REFUSES linking a SUSPENDED member", async () => {
    // MUTATION-TESTED: pins the `NOT: { status: "suspended" }` arm — delete
    // it and a deprovisioned employee can be linked back in via Slack.
    await seedIntegration({});
    await expect(
      integrations.addUserLink(ORG, "slack", {
        externalUserId: "U100",
        userId: SUSPENDED,
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("refuses linking before the workspace is connected", async () => {
    await expect(
      integrations.addUserLink(ORG, "slack", {
        externalUserId: "U100",
        userId: MEMBER,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps a duplicate link to a CONFLICT ServiceError (a 409, not a raw P2002 500)", async () => {
    // MUTATION-TESTED (the P2002 catch in addUserLink): a re-link attempt is a
    // normal user action — the honest answer is 409, not the unhandled
    // PrismaClientKnownRequestError that used to surface as a 500. Delete the
    // catch and this reads a raw `P2002` code instead of `CONFLICT`.
    await seedIntegration({});
    await integrations.addUserLink(ORG, "slack", {
      externalUserId: "U100",
      userId: MEMBER,
    });
    await expect(
      integrations.addUserLink(ORG, "slack", {
        externalUserId: "U100",
        userId: ADMIN,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("removeUserLink is fenced by org — a foreign org's link reads NOT_FOUND", async () => {
    // MUTATION-TESTED (cross-org fence): the delete carries the org in its
    // WHERE. Remove `integration: { organizationId }` from removeUserLink
    // and this test fails — an admin of one org deleting another org's links.
    const foreign = await seedIntegration({
      organizationId: OTHER_ORG,
      externalId: "T999",
    });
    const foreignLink = await linkUser(foreign.id, "U900", MEMBER);

    await expect(
      integrations.removeUserLink(ORG, foreignLink.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await db.channelUserLink.findUnique({ where: { id: foreignLink.id } }),
    ).not.toBeNull();
  });

  it("removes its own org's link", async () => {
    const integration = await seedIntegration({});
    const link = await linkUser(integration.id, "U100", MEMBER);
    await integrations.removeUserLink(ORG, link.id);
    expect(
      await db.channelUserLink.findUnique({ where: { id: link.id } }),
    ).toBeNull();
  });
});

// ── The agent-channel service ───────────────────────────────────────────────

const scriptManifestCreate = () => {
  slackHandlers["apps.manifest.create"] = () => ({
    ok: true,
    app_id: "A100",
    credentials: {
      client_id: "client-1",
      client_secret: "client-secret-1",
      signing_secret: "signing-secret-1",
    },
    oauth_authorize_url:
      "https://slack.com/oauth/v2/authorize?client_id=client-1&scope=chat%3Awrite",
  });
};

const scriptAuthTest = (
  teamId = "T111",
  team = "Acme",
  userId = "UBOT",
  user: string | undefined = "donna",
) => {
  slackHandlers["auth.test"] = () => ({
    ok: true,
    team_id: teamId,
    team,
    user_id: userId,
    user,
  });
};

describe.skipIf(!PROOF_URL)("createPresence (the guided arm)", () => {
  it("creates the Slack app and persists a pending_setup presence — events posture", async () => {
    initSelfUrl(EVENTS_SELF_URL);
    await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("guided-events");
    scriptManifestCreate();

    const result = await agentChannels.createPresence(
      WORKSPACE,
      agentId,
      "slack",
      ADMIN,
    );

    expect(result.transport).toBe("events");
    // The one-click consent URL, with our signed state riding along.
    expect(result.installUrl).toContain(
      "https://slack.com/oauth/v2/authorize?client_id=client-1",
    );
    expect(result.installUrl).toContain("&state=");
    expect(result.settingsUrl).toBe("https://api.slack.com/apps/A100/general");

    // The create used the org's automation access token.
    const [createCall] = slackCallsFor("apps.manifest.create");
    expect(createCall?.token).toBe("xoxe.access-stored");
    // The manifest baked OUR inbound URLs from the SAME origin the posture
    // helper answered — the two can never disagree.
    const manifest = JSON.parse(createCall!.form.get("manifest")!) as {
      settings: {
        socket_mode_enabled: boolean;
        event_subscriptions: { request_url?: string };
      };
      oauth_config: { redirect_urls?: string[] };
    };
    expect(manifest.settings.socket_mode_enabled).toBe(false);
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      `${EVENTS_SELF_URL}/v1/channels/slack/events`,
    );
    expect(manifest.oauth_config.redirect_urls).toEqual([
      `${EVENTS_SELF_URL}/v1/channels/slack/oauth/callback`,
    ]);

    // The half-finished attach is a tracked row, never a Slack-only orphan.
    const row = await db.agentChannel.findUniqueOrThrow({
      where: { agentId_provider: { agentId, provider: "slack" } },
    });
    expect(row.status).toBe("pending_setup");
    expect(row.externalId).toBe("A100");
    expect(row.transport).toBe("events");
    expect(JSON.parse(await getCrypto().decrypt(row.credentials!))).toEqual({
      clientId: "client-1",
      clientSecret: "client-secret-1",
      signingSecret: "signing-secret-1",
    });
  });

  it("socket posture: no install URL, socket mode baked into the manifest", async () => {
    // Default posture (http self-url) — the no-ingress floor.
    await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("guided-socket");
    scriptManifestCreate();

    const result = await agentChannels.createPresence(
      WORKSPACE,
      agentId,
      "slack",
      ADMIN,
    );

    expect(result.transport).toBe("socket");
    expect(result.installUrl).toBeNull();
    expect(result.settingsUrl).toBe("https://api.slack.com/apps/A100/general");
    const manifest = JSON.parse(
      slackCallsFor("apps.manifest.create")[0]!.form.get("manifest")!,
    ) as { settings: { socket_mode_enabled: boolean } };
    expect(manifest.settings.socket_mode_enabled).toBe(true);
  });

  it("a SECOND create while pending resumes the SAME presence — no second Slack app", async () => {
    initSelfUrl(EVENTS_SELF_URL);
    await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("guided-resume");
    scriptManifestCreate();

    const first = await agentChannels.createPresence(
      WORKSPACE,
      agentId,
      "slack",
      ADMIN,
    );
    const second = await agentChannels.createPresence(
      WORKSPACE,
      agentId,
      "slack",
      ADMIN,
    );

    expect(second.presenceId).toBe(first.presenceId);
    // MUTATION-TESTED: the resume arm — delete the `if (existing)` rebuild
    // and every retry mints another remote Slack app; the fake's hit count
    // is the proof there was exactly one create.
    expect(slackCallsFor("apps.manifest.create")).toHaveLength(1);
    // The rebuilt install URL still works, from the STORED client id.
    expect(second.installUrl).toContain("client_id=client-1");
    // The rebuilt URL's `scope` param IS the grant: the provider must join
    // the FULL bot scope list, exactly as the manifest declared it — for
    // THIS app's flavor (the integration row defaults to "agent", so the
    // rebuilt grant carries assistant:write like the manifest did).
    // MUTATION-TESTED: shrink the provider's rebuild to a partial list (the
    // old chat:write-only rebuild installed a DEAF bot — without im:history
    // the message.im subscription never delivers) and this equality fails.
    const { botScopesFor } = await import("./providers/slack/manifest");
    expect(new URL(second.installUrl!).searchParams.get("scope")).toBe(
      botScopesFor("agent").join(","),
    );
    expect(await db.agentChannel.count({ where: { agentId } })).toBe(1);
  });

  it("refuses a create while an ACTIVE presence exists", async () => {
    const { agentId } = await seedChannelAgent("guided-conflict");
    await expect(
      agentChannels.createPresence(WORKSPACE, agentId, "slack", ADMIN),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(slackCalls).toHaveLength(0);
  });

  it("an explicit socket request on events posture stamps socket", async () => {
    initSelfUrl(EVENTS_SELF_URL);
    await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("guided-choice-socket");
    scriptManifestCreate();

    const result = await agentChannels.createPresence(
      WORKSPACE,
      agentId,
      "slack",
      ADMIN,
      "socket",
    );

    expect(result.transport).toBe("socket");
    expect(result.installUrl).toBeNull();
    const manifest = JSON.parse(
      slackCallsFor("apps.manifest.create")[0]!.form.get("manifest")!,
    ) as { settings: { socket_mode_enabled: boolean } };
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    const row = await db.agentChannel.findUniqueOrThrow({
      where: { agentId_provider: { agentId, provider: "slack" } },
    });
    expect(row.transport).toBe("socket");
  });

  it("refuses an events request without a public https origin", async () => {
    // Default posture: socket self-url — events physically can't reach us.
    await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("guided-choice-events-refused");
    await expect(
      agentChannels.createPresence(
        WORKSPACE,
        agentId,
        "slack",
        ADMIN,
        "events",
      ),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    expect(slackCalls).toHaveLength(0);
  });

  it("refuses a socket request on the cloud edition — the product clamp, not the URL scheme", async () => {
    initSelfUrl(EVENTS_SELF_URL);
    await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("guided-choice-cloud-clamp");
    // `isOnpremEdition()` reads env call-time, so this flip is visible without
    // a re-import — and MUST be restored (the suite's semantics are onprem;
    // see the beforeAll pin's worker-leak warning).
    process.env.EDITION = "cloud";
    process.env.NEXT_PUBLIC_EDITION = "cloud";
    try {
      await expect(
        agentChannels.createPresence(
          WORKSPACE,
          agentId,
          "slack",
          ADMIN,
          "socket",
        ),
      ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    } finally {
      process.env.EDITION = "onprem";
      process.env.NEXT_PUBLIC_EDITION = "onprem";
    }
    expect(slackCalls).toHaveLength(0);
  });

  it("a resume keeps the row's stamp through posture drift, and refuses a conflicting request", async () => {
    // Stamp events, then flip the deployment posture to socket-only.
    initSelfUrl(EVENTS_SELF_URL);
    await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("guided-resume-stamp");
    scriptManifestCreate();
    await agentChannels.createPresence(WORKSPACE, agentId, "slack", ADMIN);

    initSelfUrl(SOCKET_SELF_URL);
    const resumed = await agentChannels.createPresence(
      WORKSPACE,
      agentId,
      "slack",
      ADMIN,
    );
    // The row's stamp wins — and the events resume still carries a usable
    // install URL: the OAuth state is minted for the ROW's transport, not the
    // drifted default (mint it off the default and this URL loses its state).
    expect(resumed.transport).toBe("events");
    expect(resumed.installUrl).toContain("&state=");

    await expect(
      agentChannels.createPresence(
        WORKSPACE,
        agentId,
        "slack",
        ADMIN,
        "socket",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Neither the resume nor the refusal minted a second Slack app.
    expect(slackCallsFor("apps.manifest.create")).toHaveLength(1);
  });

  it("a socket-stamped pending row RESUMES under an events-only posture — the stamp wins, nothing is discarded", async () => {
    // The stamp-wins law's other direction: the row says socket while the
    // deployment has drifted to events-ONLY (https origin + cloud edition, so
    // socket is not even offered to a NEW create). A socket resume needs no
    // URL rebuild, so it can always finish — the self-heal discard must NOT
    // fire, or a retry click would silently uninstall the user's real app.
    initSelfUrl(EVENTS_SELF_URL);
    const integration = await seedIntegration({});
    const agentId = await seedAgent("guided-stamp-socket");
    const staleKey = await db.apiKey.create({
      data: {
        key: `oc_${P}stamp-socket-key`,
        userId: ADMIN,
        userEmail: `${ADMIN}@example.com`,
        workspaceId: WORKSPACE,
        scope: "workspace",
        kind: "service",
      },
      select: { id: true },
    });
    const pending = await seedPresence(agentId, integration.id, {
      status: "pending_setup",
      externalId: "A-SOCK-STALE",
      apiKeyId: staleKey.id,
      credentials: await getCrypto().encrypt(
        JSON.stringify({
          clientId: "client-sock",
          clientSecret: "cs-sock",
          signingSecret: "ss-sock",
        }),
      ),
    });

    // `isOnpremEdition()` reads env call-time, so this flip is visible without
    // a re-import — and MUST be restored (the suite's semantics are onprem;
    // see the beforeAll pin's worker-leak warning).
    process.env.EDITION = "cloud";
    process.env.NEXT_PUBLIC_EDITION = "cloud";
    try {
      const resumed = await agentChannels.createPresence(
        WORKSPACE,
        agentId,
        "slack",
        ADMIN,
      );
      expect(resumed.presenceId).toBe(pending.id);
      expect(resumed.transport).toBe("socket");
      expect(resumed.installUrl).toBeNull();
    } finally {
      process.env.EDITION = "onprem";
      process.env.NEXT_PUBLIC_EDITION = "onprem";
    }

    // No discard side effects: the row survives, its service key survives,
    // and Slack heard NOTHING (no uninstall, no second manifest create).
    expect(
      await db.agentChannel.findUnique({ where: { id: pending.id } }),
    ).not.toBeNull();
    expect(
      await db.apiKey.findUnique({ where: { id: staleKey.id } }),
    ).not.toBeNull();
    expect(slackCalls).toHaveLength(0);
  });

  it("DISCARDS a pending events row whose consent URL can no longer be rebuilt, and mints fresh in the SAME call", async () => {
    // The self-heal arm. An events resume is only viable while the stored
    // credentials can rebuild the consent URL; this row's blob never captured
    // a client id (interrupted before the manifest response was stored, or a
    // paste-floor shape), so `rebuildSetupUrls` answers installUrl: null and
    // the retry click must discard-and-remint rather than hand back a dead
    // resume. MUTATION-TESTED: skip the discard's `revokeServiceApiKey` (or
    // its row delete / uninstall dispatch) and this test goes red.
    initSelfUrl(EVENTS_SELF_URL);
    const integration = await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("guided-discard");
    const staleKey = await db.apiKey.create({
      data: {
        key: `oc_${P}discard-stale-key`,
        userId: ADMIN,
        userEmail: `${ADMIN}@example.com`,
        workspaceId: WORKSPACE,
        scope: "workspace",
        kind: "service",
      },
      select: { id: true },
    });
    const staleCredentialsJson = JSON.stringify({
      botToken: "xoxb-stale",
      clientSecret: "cs-stale",
    });
    const stale = await db.agentChannel.create({
      data: {
        agentId,
        integrationId: integration.id,
        provider: "slack",
        externalId: "A-STALE",
        transport: "events",
        status: "pending_setup",
        credentials: await getCrypto().encrypt(staleCredentialsJson),
        apiKeyId: staleKey.id,
        createdByUserId: ADMIN,
      },
      select: { id: true },
    });
    scriptManifestCreate();
    // The best-effort remote uninstall is observed at the provider seam: the
    // Slack impl then no-ops at the HTTP seam on THIS row, because the same
    // missing client id that killed the rebuild also gates `apps.uninstall`.
    // Wrapped by hand — the method is OPTIONAL on the provider interface, so
    // `vi.spyOn` cannot type it; the wrap still calls through to the real
    // implementation.
    const { CHANNEL_PROVIDERS } = await import("./registry");
    const slackProvider = CHANNEL_PROVIDERS.slack;
    const realUninstall =
      slackProvider.uninstallRemotePresence?.bind(slackProvider);
    if (!realUninstall) {
      throw new Error("the slack provider must expose uninstallRemotePresence");
    }
    const uninstallCalls: { credentialsJson: string | null }[] = [];
    slackProvider.uninstallRemotePresence = async (input) => {
      uninstallCalls.push(input);
      return realUninstall(input);
    };

    try {
      const result = await agentChannels.createPresence(
        WORKSPACE,
        agentId,
        "slack",
        ADMIN,
      );

      // A FRESH mint, not a resume: a new remote app and a LIVE consent URL.
      expect(result.presenceId).not.toBe(stale.id);
      expect(result.transport).toBe("events");
      expect(result.installUrl).toContain("client_id=client-1");
      expect(result.installUrl).toContain("&state=");
      expect(slackCallsFor("apps.manifest.create")).toHaveLength(1);

      // The stale row is GONE...
      expect(
        await db.agentChannel.findUnique({ where: { id: stale.id } }),
      ).toBeNull();
      // ...its service key was revoked (revoke = the row is deleted)...
      expect(
        await db.apiKey.findUnique({ where: { id: staleKey.id } }),
      ).toBeNull();
      // ...and the remote uninstall was ATTEMPTED on the stale row's own
      // decrypted credentials (HTTP no-op here — see the wrap comment above).
      expect(uninstallCalls).toEqual([
        { credentialsJson: staleCredentialsJson },
      ]);
      expect(slackCallsFor("apps.uninstall")).toHaveLength(0);

      // Exactly ONE presence remains: the fresh pending_setup row.
      const rows = await db.agentChannel.findMany({
        where: { agentId },
        select: { id: true, status: true, externalId: true },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(result.presenceId);
      expect(rows[0]!.status).toBe("pending_setup");
      expect(rows[0]!.externalId).toBe("A100");
    } finally {
      slackProvider.uninstallRemotePresence = realUninstall;
    }
  });
});

describe.skipIf(!PROOF_URL)("completePresence (the paste floor)", () => {
  it("activates from pasted tokens, minting a credential-LESS integration row", async () => {
    // Socket posture floor: no org credential, no guided create — the whole
    // integration row is minted here, and it must carry NO credential (the
    // org token is an accelerator, never a gate).
    const agentId = await seedAgent("floor-socket");
    scriptAuthTest();

    const presence = await agentChannels.completePresence(
      WORKSPACE,
      agentId,
      "slack",
      {
        botToken: "xoxb-floor-token",
        appToken: "xapp-floor-token",
        appId: "A200",
      },
      ADMIN,
    );

    expect(presence.status).toBe("active");
    expect(presence.identityRef).toBe("UBOT");
    expect(presence.externalId).toBe("A200");

    // secM1: the complete-door RETURN value (handed to the browser) carries the
    // integration IDENTITY only — never its credential ciphertext. presenceSelect
    // deliberately drops integration.credentials; drop that omission and an org
    // automation credential (even encrypted) leaves the server.
    expect(presence.integration).toMatchObject({ externalId: "T111" });
    expect(presence.integration).not.toHaveProperty("credentials");

    const integration = await db.channelIntegration.findUniqueOrThrow({
      where: {
        organizationId_provider: { organizationId: ORG, provider: "slack" },
      },
    });
    expect(integration.externalId).toBe("T111");
    expect(integration.name).toBe("Acme");
    expect(integration.credentials).toBeNull();
    expect(integration.credentialsRotatedAt).toBeNull();

    const row = await db.agentChannel.findUniqueOrThrow({
      where: { agentId_provider: { agentId, provider: "slack" } },
    });
    expect(JSON.parse(await getCrypto().decrypt(row.credentials!))).toEqual({
      botToken: "xoxb-floor-token",
      appToken: "xapp-floor-token",
    });
  });

  it("stamps the floor's explicit socket choice on an events-posture deployment", async () => {
    initSelfUrl(EVENTS_SELF_URL);
    const agentId = await seedAgent("floor-choice-socket");
    scriptAuthTest();

    const presence = await agentChannels.completePresence(
      WORKSPACE,
      agentId,
      "slack",
      {
        botToken: "xoxb-floor-token",
        appToken: "xapp-floor-token",
        appId: "A210",
        transport: "socket",
      },
      ADMIN,
    );

    expect(presence.transport).toBe("socket");
  });

  it("refuses a transport that contradicts a pending row's stamp", async () => {
    initSelfUrl(EVENTS_SELF_URL);
    await seedIntegration({
      credentials: await integrationCredentials(12 * 3600),
    });
    const agentId = await seedAgent("floor-choice-conflict");
    scriptManifestCreate();
    // The guided create stamps events; a socket-flavored paste must not
    // silently complete onto it.
    await agentChannels.createPresence(WORKSPACE, agentId, "slack", ADMIN);

    await expect(
      agentChannels.completePresence(
        WORKSPACE,
        agentId,
        "slack",
        { botToken: "xoxb-x", appToken: "xapp-x", transport: "socket" },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("requires the App ID when no guided create ran", async () => {
    const agentId = await seedAgent("floor-no-appid");
    await expect(
      agentChannels.completePresence(
        WORKSPACE,
        agentId,
        "slack",
        { botToken: "xoxb-x", appToken: "xapp-x" },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("enforces the bot token prefix BEFORE talking to Slack", async () => {
    const agentId = await seedAgent("floor-badbot");
    await expect(
      agentChannels.completePresence(
        WORKSPACE,
        agentId,
        "slack",
        { botToken: "xoxp-a-user-token", appId: "A200" },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    expect(slackCallsFor("auth.test")).toHaveLength(0);
  });

  it("the socket arm requires an xapp- app-level token", async () => {
    const agentId = await seedAgent("floor-noapp");
    await expect(
      agentChannels.completePresence(
        WORKSPACE,
        agentId,
        "slack",
        { botToken: "xoxb-x", appId: "A200" },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    await expect(
      agentChannels.completePresence(
        WORKSPACE,
        agentId,
        "slack",
        { botToken: "xoxb-x", appToken: "not-an-xapp", appId: "A200" },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("the EVENTS floor requires the signing secret (inbound routes cannot verify without it)", async () => {
    initSelfUrl(EVENTS_SELF_URL);
    const agentId = await seedAgent("floor-events");
    scriptAuthTest();

    await expect(
      agentChannels.completePresence(
        WORKSPACE,
        agentId,
        "slack",
        { botToken: "xoxb-x", appId: "A200" },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });

    const presence = await agentChannels.completePresence(
      WORKSPACE,
      agentId,
      "slack",
      { botToken: "xoxb-x", signingSecret: "sekrit", appId: "A200" },
      ADMIN,
    );
    expect(presence.status).toBe("active");
    const row = await db.agentChannel.findUniqueOrThrow({
      where: { agentId_provider: { agentId, provider: "slack" } },
    });
    expect(
      JSON.parse(await getCrypto().decrypt(row.credentials!)),
    ).toMatchObject({ signingSecret: "sekrit" });
  });

  it("REFUSES a bot from a different workspace than the org's integration", async () => {
    // MUTATION-TESTED (tenant fence): delete the externalId comparison in
    // activatePresence and a token from ANY workspace attaches into this
    // org — its users would then be matched against this org's links.
    await seedIntegration({ externalId: "T111" });
    const agentId = await seedAgent("floor-mismatch");
    scriptAuthTest("T999", "Somewhere Else");

    await expect(
      agentChannels.completePresence(
        WORKSPACE,
        agentId,
        "slack",
        { botToken: "xoxb-x", appToken: "xapp-x", appId: "A200" },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await db.agentChannel.findUnique({
        where: { agentId_provider: { agentId, provider: "slack" } },
      }),
    ).toBeNull();
  });

  it("app-id squat: a second agent pasting an already-attached appId is a CONFLICT, and its service key is REVOKED", async () => {
    // The `(provider, externalId)` unique makes an app-id collision a CONFLICT
    // at attach — a hostile tenant cannot squat a victim's Slack app id and
    // shadow their inbound routing. MUTATION-TESTED twice over: drop the
    // P2002→CONFLICT mapping in activatePresence and this reads a raw Prisma
    // code; drop the revokeServiceApiKey-on-failure and the failed attach
    // STRANDS a kind:"service" key with no owner-facing way to revoke it. (webM4)
    const agentA = await seedAgent("squat-a");
    scriptAuthTest();
    await agentChannels.completePresence(
      WORKSPACE,
      agentA,
      "slack",
      { botToken: "xoxb-a", appToken: "xapp-a", appId: "A-squat" },
      ADMIN,
    );
    expect(
      await db.apiKey.count({
        where: { userId: ADMIN, workspaceId: WORKSPACE, kind: "service" },
      }),
    ).toBe(1);

    const agentB = await seedAgent("squat-b");
    await expect(
      agentChannels.completePresence(
        WORKSPACE,
        agentB,
        "slack",
        { botToken: "xoxb-b", appToken: "xapp-b", appId: "A-squat" },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Agent B got no presence row...
    expect(
      await db.agentChannel.findUnique({
        where: { agentId_provider: { agentId: agentB, provider: "slack" } },
      }),
    ).toBeNull();
    // ...and NO orphan service key survives: still exactly one (agent A's).
    expect(
      await db.apiKey.count({
        where: { userId: ADMIN, workspaceId: WORKSPACE, kind: "service" },
      }),
    ).toBe(1);
  });
});

describe.skipIf(!PROOF_URL)(
  "completePresenceFromOAuth (the events install)",
  () => {
    it("exchanges the code with client creds as HTTP Basic — the secret NEVER rides the form body", async () => {
      // oauth.v2.access, docs-preferred shape: `Authorization: Basic
      // base64(client_id:client_secret)`, with ONLY {code, redirect_uri} in the
      // form. MUTATION-TESTED: move the creds back into form params and the
      // header assertion fails while client_secret shows up in the form — i.e.
      // the secret starts landing in URL-encoded request bodies and whatever
      // logs them.
      initSelfUrl(EVENTS_SELF_URL);
      await seedIntegration({
        credentials: await integrationCredentials(12 * 3600),
      });
      const agentId = await seedAgent("oauth-basic");
      scriptManifestCreate();
      const created = await agentChannels.createPresence(
        WORKSPACE,
        agentId,
        "slack",
        ADMIN,
      );
      // The signed state rides the install URL; the callback hands it back.
      const state = new URL(created.installUrl!).searchParams.get("state")!;
      expect(state).toBeTruthy();

      slackHandlers["oauth.v2.access"] = () => ({
        ok: true,
        access_token: "xoxb-oauth-bot",
        bot_user_id: "UBOT9",
        team: { id: "T111", name: "Acme" },
      });

      const redirectUri = `${EVENTS_SELF_URL}/v1/channels/slack/oauth/callback`;
      const completed = await agentChannels.completePresenceFromOAuth({
        state,
        code: "slack-consent-code",
        redirectUri,
      });

      // The exchange itself: Basic auth carrying id:secret, verbatim.
      const [exchange] = slackCallsFor("oauth.v2.access");
      expect(exchange).toBeDefined();
      const basic = exchange!.authorization;
      expect(basic).toMatch(/^Basic /);
      expect(
        Buffer.from(basic!.slice("Basic ".length), "base64").toString("utf8"),
      ).toBe("client-1:client-secret-1");
      // No Bearer, and a form of EXACTLY {code, redirect_uri}.
      expect(exchange!.token).toBeNull();
      expect(exchange!.form.get("code")).toBe("slack-consent-code");
      expect(exchange!.form.get("redirect_uri")).toBe(redirectUri);
      expect(exchange!.form.get("client_secret")).toBeNull();
      expect(exchange!.form.get("client_id")).toBeNull();

      // And the exchange activated the presence with Slack's answer.
      expect(completed).toMatchObject({ agentId, workspaceId: WORKSPACE });
      const row = await db.agentChannel.findUniqueOrThrow({
        where: { agentId_provider: { agentId, provider: "slack" } },
      });
      expect(row.status).toBe("active");
      expect(row.identityRef).toBe("UBOT9");
      expect(
        JSON.parse(await getCrypto().decrypt(row.credentials!)),
      ).toMatchObject({
        botToken: "xoxb-oauth-bot",
        clientId: "client-1",
        signingSecret: "signing-secret-1",
      });
    });

    it("REFUSES an exchange naming a different workspace — nothing activates, nothing is stored", async () => {
      // MUTATION-TESTED (the OAuth arm of the tenant fence): delete the
      // externalId comparison in activatePresence and a consent click in ANY
      // workspace — Slack's screen lets the user pick freely; a re-run never
      // guarantees the original workspace — attaches this org's agent to a
      // foreign workspace, whose users would then be matched against this
      // org's links. The paste door has its own arm of this proof; this is
      // the exchange door's.
      initSelfUrl(EVENTS_SELF_URL);
      await seedIntegration({
        credentials: await integrationCredentials(12 * 3600),
      });
      const agentId = await seedAgent("oauth-mismatch");
      scriptManifestCreate();
      const created = await agentChannels.createPresence(
        WORKSPACE,
        agentId,
        "slack",
        ADMIN,
      );
      const state = new URL(created.installUrl!).searchParams.get("state")!;

      slackHandlers["oauth.v2.access"] = () => ({
        ok: true,
        access_token: "xoxb-foreign-bot",
        bot_user_id: "UFOREIGN",
        team: { id: "T999", name: "Somewhere Else" },
      });

      await expect(
        agentChannels.completePresenceFromOAuth({
          state,
          code: "slack-consent-code",
          redirectUri: `${EVENTS_SELF_URL}/v1/channels/slack/oauth/callback`,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      // The presence never activated and the foreign bot token is NOT stored.
      const row = await db.agentChannel.findUniqueOrThrow({
        where: { agentId_provider: { agentId, provider: "slack" } },
      });
      expect(row.status).toBe("pending_setup");
      expect(
        JSON.parse(await getCrypto().decrypt(row.credentials!)),
      ).not.toHaveProperty("botToken");
      // The fence fires BEFORE the service-key mint — no orphan key exists.
      expect(
        await db.apiKey.count({
          where: { userId: ADMIN, workspaceId: WORKSPACE, kind: "service" },
        }),
      ).toBe(0);
    });
  },
);

describe.skipIf(!PROOF_URL)("the ApiKey.kind seam", () => {
  it("activation mints a SERVICE key the personal-key flows never see or disturb", async () => {
    const agentId = await seedAgent("kind-seam");
    scriptAuthTest();
    const presence = await agentChannels.completePresence(
      WORKSPACE,
      agentId,
      "slack",
      { botToken: "xoxb-k", appToken: "xapp-k", appId: "A300" },
      ADMIN,
    );

    const serviceKey = await db.apiKey.findFirstOrThrow({
      where: { userId: ADMIN, workspaceId: WORKSPACE, kind: "service" },
    });
    expect(presence.apiKeyId).toBe(serviceKey.id);
    expect(serviceKey.name).toBe("Slack · agent kind-seam");

    // THE REGRESSION UNDER TEST — MUTATION-TESTED: remove the `kind: "user"`
    // filter from regenerateApiKey/ensureApiKey and the assertions below
    // fail: regenerate would rotate the approvals key out from under the
    // adapter mid-flight, and ensure would hand the personal flow the
    // service credential.
    const regenerated = await apiKeys.regenerateApiKey(ADMIN, {
      workspaceId: WORKSPACE,
    });
    expect(regenerated.apiKey).not.toBe(serviceKey.key);

    const ensured = await apiKeys.ensureApiKey(ADMIN, {
      workspaceId: WORKSPACE,
    });
    expect(ensured.apiKey).not.toBe(serviceKey.key);
    expect(ensured.apiKey).toBe(regenerated.apiKey);
    expect(ensured.created).toBe(false);

    // The service key row itself: same id, same key, untouched by both.
    const after = await db.apiKey.findUniqueOrThrow({
      where: { id: serviceKey.id },
    });
    expect(after.key).toBe(serviceKey.key);
    expect(after.kind).toBe("service");
    // And exactly one personal key exists beside it.
    expect(
      await db.apiKey.count({
        where: { userId: ADMIN, workspaceId: WORKSPACE, kind: "user" },
      }),
    ).toBe(1);
  });

  it("revokeServiceApiKey is FENCED to kind:service — it never deletes a personal key", async () => {
    // MUTATION-TESTED: drop the `kind: "service"` from revokeServiceApiKey's
    // deleteMany and a teardown could delete a person's own key by id. A
    // personal key id handed to it must SURVIVE; a real service key is revoked
    // cleanly and a second revoke is an idempotent no-op.
    const personal = await db.apiKey.create({
      data: {
        key: `oc_${P}personal-key`,
        userId: ADMIN,
        userEmail: `${ADMIN}@example.com`,
        workspaceId: WORKSPACE,
        scope: "workspace",
        kind: "user",
      },
      select: { id: true },
    });
    const service = await apiKeys.createServiceApiKey(
      ADMIN,
      { workspaceId: WORKSPACE },
      "svc-direct",
    );
    const serviceRow = await db.apiKey.findUniqueOrThrow({
      where: { id: service.id },
    });
    expect(serviceRow.kind).toBe("service");
    expect(serviceRow.userId).toBe(ADMIN);
    expect(serviceRow.key).toBe(service.apiKey);

    // Wrong-kind id → no-op: the personal key is untouched.
    await apiKeys.revokeServiceApiKey(personal.id);
    expect(
      await db.apiKey.findUnique({ where: { id: personal.id } }),
    ).not.toBeNull();

    // The real service key is revoked; revoking again is idempotent.
    await apiKeys.revokeServiceApiKey(service.id);
    expect(
      await db.apiKey.findUnique({ where: { id: service.id } }),
    ).toBeNull();
    await expect(
      apiKeys.revokeServiceApiKey(service.id),
    ).resolves.toBeUndefined();
  });
});

/** Let the tombstone rename SUCCEED — the gate every delete test must pass. */
const scriptRenameLands = (appId: string) => {
  slackHandlers["apps.manifest.export"] = () => ({
    ok: true,
    manifest: {
      display_information: { name: "before" },
      features: { bot_user: { display_name: "before" } },
    },
  });
  slackHandlers["apps.manifest.update"] = () => ({ ok: true });
  slackHandlers["users.info"] = () => ({
    ok: true,
    user: { id: "UBOT", profile: { real_name: `deleted-app-${appId}` } },
  });
};

describe.skipIf(!PROOF_URL)("detachPresence", () => {
  const seedActivated = async (suffix: string) => {
    const agentId = await seedAgent(suffix);
    scriptAuthTest();
    const presence = await agentChannels.completePresence(
      WORKSPACE,
      agentId,
      "slack",
      { botToken: "xoxb-d", appToken: "xapp-d", appId: `A-${suffix}` },
      ADMIN,
    );
    return { agentId, presence };
  };

  it("removes presence, links and the service key — conversations SURVIVE", async () => {
    const { agentId, presence } = await seedActivated("detach-keep");
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", direct: true, userId: MEMBER },
      select: { id: true },
    });
    await db.channelThreadLink.create({
      data: {
        agentChannelId: presence.id,
        conversationId: conversation.id,
        externalThreadId: "D555",
        kind: "direct",
        externalUserId: "U111",
      },
    });

    await agentChannels.detachPresence(WORKSPACE, agentId, "slack", {
      deleteRemote: false,
    });

    // Detach WITHOUT delete keeps the row as a pending_setup shell so the
    // next attach reuses the SAME Slack app instead of minting a sibling.
    const shell = await db.agentChannel.findUnique({
      where: { id: presence.id },
      select: { status: true, externalId: true, apiKeyId: true },
    });
    expect(shell?.status).toBe("pending_setup");
    expect(shell?.externalId).toBe(presence.externalId);
    expect(shell?.apiKeyId).toBeNull();
    expect(
      await db.channelThreadLink.count({
        where: { agentChannelId: presence.id },
      }),
    ).toBe(0);
    // The service key ROW is deleted, not orphaned.
    expect(
      await db.apiKey.findUnique({ where: { id: presence.apiKeyId! } }),
    ).toBeNull();
    // History is the user's: the conversation outlives the presence.
    expect(
      await db.conversation.findUnique({ where: { id: conversation.id } }),
    ).not.toBeNull();

    // And the next attach RESUMES this shell: same row, same app id, no
    // second apps.manifest.create.
    const before = slackCallsFor("apps.manifest.create").length;
    const resumed = await agentChannels.createPresence(
      WORKSPACE,
      agentId,
      "slack",
      ADMIN,
    );
    expect(resumed.presenceId).toBe(presence.id);
    expect(slackCallsFor("apps.manifest.create")).toHaveLength(before);
  });

  it("deleteRemote asks Slack to delete the app, via a fresh org credential", async () => {
    const { agentId, presence } = await seedActivated("detach-remote");
    await db.channelIntegration.updateMany({
      where: { organizationId: ORG, provider: "slack" },
      data: {
        credentials: await integrationCredentials(12 * 3600),
        credentialsRotatedAt: new Date(),
      },
    });
    scriptRenameLands(presence.externalId);
    slackHandlers["apps.manifest.delete"] = () => ({ ok: true });

    await agentChannels.detachPresence(WORKSPACE, agentId, "slack", {
      deleteRemote: true,
    });

    const [deleteCall] = slackCallsFor("apps.manifest.delete");
    expect(deleteCall?.form.get("app_id")).toBe(presence.externalId);
    expect(deleteCall?.token).toBe("xoxe.access-stored");
    expect(
      await db.agentChannel.findUnique({ where: { id: presence.id } }),
    ).toBeNull();
  });

  it("a FAILED remote delete still detaches locally (best-effort by contract)", async () => {
    const { agentId, presence } = await seedActivated("detach-fail");
    await db.channelIntegration.updateMany({
      where: { organizationId: ORG, provider: "slack" },
      data: {
        credentials: await integrationCredentials(12 * 3600),
        credentialsRotatedAt: new Date(),
      },
    });
    scriptRenameLands(presence.externalId);
    slackHandlers["apps.manifest.delete"] = () => ({
      ok: false,
      error: "app_not_found",
    });

    await agentChannels.detachPresence(WORKSPACE, agentId, "slack", {
      deleteRemote: true,
    });

    expect(slackCallsFor("apps.manifest.delete")).toHaveLength(1);
    expect(
      await db.agentChannel.findUnique({ where: { id: presence.id } }),
    ).toBeNull();
  });

  // The ORDER is the behaviour under test: rename, uninstall, delete. A
  // deleted app can no longer be renamed OR uninstalled.
  describe("the app is uninstalled before its record is deleted", () => {
    const seedWithClientCreds = async (suffix: string) => {
      const seeded = await seedActivated(suffix);
      // The guided arm captures these at create; `seedActivated` takes the
      // paste floor, which does not.
      await db.agentChannel.update({
        where: { id: seeded.presence.id },
        data: {
          credentials: await getCrypto().encrypt(
            JSON.stringify({
              botToken: "xoxb-d",
              clientId: "client-1",
              clientSecret: "client-secret-1",
            }),
          ),
        },
      });
      await db.channelIntegration.updateMany({
        where: { organizationId: ORG, provider: "slack" },
        data: {
          credentials: await integrationCredentials(12 * 3600),
          credentialsRotatedAt: new Date(),
        },
      });
      return seeded;
    };

    it("uninstalls with the app's OWN client credentials, then deletes", async () => {
      const { agentId, presence } = await seedWithClientCreds("detach-uninst");
      scriptRenameLands(presence.externalId);
      slackHandlers["apps.uninstall"] = () => ({ ok: true });
      slackHandlers["apps.manifest.delete"] = () => ({ ok: true });

      await agentChannels.detachPresence(WORKSPACE, agentId, "slack", {
        deleteRemote: true,
      });

      const [uninstall] = slackCallsFor("apps.uninstall");
      expect(uninstall?.form.get("client_id")).toBe("client-1");
      expect(uninstall?.form.get("client_secret")).toBe("client-secret-1");
      // Installation-scoped: the app's own bot token, NOT the org config token.
      expect(uninstall?.token).toBe("xoxb-d");

      const [deleted] = slackCallsFor("apps.manifest.delete");
      expect(deleted?.form.get("app_id")).toBe(presence.externalId);

      // Order is the whole point: uninstall must precede the delete, since a
      // deleted app can no longer be uninstalled.
      const order = slackCalls
        .map((c) => c.method)
        .filter((m) => m === "apps.uninstall" || m === "apps.manifest.delete");
      expect(order).toEqual(["apps.uninstall", "apps.manifest.delete"]);
    });

    // The bot user outlives the app as a permanent workspace record, keeping
    // whatever name it had — so deleting an agent called "donna" would leave a
    // dead "donna" answering searches for the live person. Renaming just
    // before the delete is the only chance to change that: a deleted app
    // refuses every manifest call.
    it("renames the app to a tombstone BEFORE deleting it", async () => {
      const { agentId } = await seedWithClientCreds("detach-tombstone");
      slackHandlers["apps.uninstall"] = () => ({ ok: true });
      slackHandlers["apps.manifest.export"] = () => ({
        ok: true,
        manifest: {
          display_information: { name: "donna", description: "keep me" },
          features: {
            bot_user: { display_name: "donna", always_online: true },
          },
          oauth_config: { scopes: { bot: ["chat:write"] } },
        },
      });
      slackHandlers["apps.manifest.update"] = () => ({ ok: true });
      slackHandlers["apps.manifest.delete"] = () => ({ ok: true });
      // Slack applies a rename to the bot user asynchronously, so teardown
      // POLLS this until it matches before it dares delete anything.
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: {
          id: "UBOT",
          profile: { real_name: "deleted-app-A-detach-tombstone" },
        },
      });

      await agentChannels.detachPresence(WORKSPACE, agentId, "slack", {
        deleteRemote: true,
      });

      const [update] = slackCallsFor("apps.manifest.update");
      const sent = JSON.parse(update?.form.get("manifest") ?? "{}");
      const tombstone = "deleted-app-A-detach-tombstone";
      // Both fields: one shows in the app directory, one as the bot's name.
      expect(sent.display_information?.name).toBe(tombstone);
      expect(sent.features?.bot_user?.display_name).toBe(tombstone);
      // The rest rides through untouched — never rebuilt from scratch.
      expect(sent.display_information?.description).toBe("keep me");
      expect(sent.features?.bot_user?.always_online).toBe(true);
      expect(sent.oauth_config?.scopes?.bot).toEqual(["chat:write"]);

      // The WHOLE order. An earlier version asserted only rename-before-delete
      // and passed while the rename sat after the uninstall, doing nothing.
      const order = slackCalls
        .map((c) => c.method)
        .filter(
          (m) =>
            m === "apps.manifest.update" ||
            m === "apps.uninstall" ||
            m === "apps.manifest.delete",
        );
      expect(order).toEqual([
        "apps.manifest.update",
        "apps.uninstall",
        "apps.manifest.delete",
      ]);
    });

    // Left ALIVE on purpose: better a live app the customer can remove than a
    // permanent look-alike of a real person.
    it("REFUSES to delete an app it could not rename", async () => {
      const { agentId, presence } = await seedWithClientCreds("detach-tsfail");
      slackHandlers["apps.uninstall"] = () => ({ ok: true });
      slackHandlers["apps.manifest.export"] = () => ({
        ok: false,
        error: "app_not_found",
      });
      slackHandlers["apps.manifest.delete"] = () => ({ ok: true });

      await agentChannels.detachPresence(WORKSPACE, agentId, "slack", {
        deleteRemote: true,
      });

      expect(slackCallsFor("apps.manifest.update")).toHaveLength(0);
      expect(slackCallsFor("apps.manifest.delete")).toHaveLength(0);
      // The local detach still completes: the platform never stays half-attached.
      expect(
        await db.agentChannel.findUnique({ where: { id: presence.id } }),
      ).toBeNull();
    });

    // Slack accepts the rename but applies it asynchronously (~5s), so a
    // teardown that raced ahead deleted before it landed. The give-up path
    // polls its full window, hence the longer timeout.
    it("REFUSES to delete when the rename never reaches the bot user", async () => {
      const { agentId, presence } = await seedWithClientCreds("detach-tsslow");
      slackHandlers["apps.uninstall"] = () => ({ ok: true });
      slackHandlers["apps.manifest.export"] = () => ({
        ok: true,
        manifest: {
          display_information: { name: "donna" },
          features: { bot_user: { display_name: "donna" } },
        },
      });
      slackHandlers["apps.manifest.update"] = () => ({ ok: true });
      // Accepted, but the bot user still answers with the OLD name.
      slackHandlers["users.info"] = () => ({
        ok: true,
        user: { id: "UBOT", profile: { real_name: "donna" } },
      });
      slackHandlers["apps.manifest.delete"] = () => ({ ok: true });

      await agentChannels.detachPresence(WORKSPACE, agentId, "slack", {
        deleteRemote: true,
      });

      expect(slackCallsFor("apps.manifest.update")).toHaveLength(1);
      expect(slackCallsFor("apps.manifest.delete")).toHaveLength(0);
      expect(
        await db.agentChannel.findUnique({ where: { id: presence.id } }),
      ).toBeNull();
    }, 20_000);

    it("a REFUSED uninstall still deletes the app", async () => {
      const { agentId, presence } =
        await seedWithClientCreds("detach-unrefuse");
      scriptRenameLands(presence.externalId);
      slackHandlers["apps.uninstall"] = () => ({
        ok: false,
        error: "account_inactive",
      });
      slackHandlers["apps.manifest.delete"] = () => ({ ok: true });

      await agentChannels.detachPresence(WORKSPACE, agentId, "slack", {
        deleteRemote: true,
      });

      expect(slackCallsFor("apps.uninstall")).toHaveLength(1);
      expect(slackCallsFor("apps.manifest.delete")).toHaveLength(1);
      expect(
        await db.agentChannel.findUnique({ where: { id: presence.id } }),
      ).toBeNull();
    });

    it("skips the uninstall when we hold no client credentials", async () => {
      // The paste floor: the user made the app, so we never saw its secret.
      const { agentId, presence } = await seedActivated("detach-nocreds");
      scriptRenameLands(presence.externalId);
      await db.channelIntegration.updateMany({
        where: { organizationId: ORG, provider: "slack" },
        data: {
          credentials: await integrationCredentials(12 * 3600),
          credentialsRotatedAt: new Date(),
        },
      });
      slackHandlers["apps.manifest.delete"] = () => ({ ok: true });

      await agentChannels.detachPresence(WORKSPACE, agentId, "slack", {
        deleteRemote: true,
      });

      expect(slackCallsFor("apps.uninstall")).toHaveLength(0);
      expect(slackCallsFor("apps.manifest.delete")).toHaveLength(1);
    });

    // The regression that shipped: the uninstall used to sit INSIDE the
    // org-credential wrapper, which throws for an org with no config token —
    // so nothing was called at all and the app stayed live in the customer's
    // workspace while the console reported a successful delete. Found in the
    // wild: two apps left installed in the customer's workspace after their
    // agents were deleted, because nothing ever reached Slack.
    it("STILL uninstalls when the org has NO config token — only the manifest delete is skipped", async () => {
      const { agentId, presence } = await seedWithClientCreds("detach-noorg");
      // The failing configuration, exactly: a presence with its own creds, an
      // org integration row with none.
      await db.channelIntegration.updateMany({
        where: { organizationId: ORG, provider: "slack" },
        data: { credentials: null, credentialsRotatedAt: null },
      });
      slackHandlers["apps.uninstall"] = () => ({ ok: true });
      slackHandlers["apps.manifest.delete"] = () => ({ ok: true });

      await agentChannels.detachPresence(WORKSPACE, agentId, "slack", {
        deleteRemote: true,
      });

      // The half that matters to the customer still happens.
      const [uninstall] = slackCallsFor("apps.uninstall");
      expect(uninstall?.form.get("client_id")).toBe("client-1");
      // The half that genuinely needs the org token does not, and that is fine.
      expect(slackCallsFor("apps.manifest.delete")).toHaveLength(0);
      expect(
        await db.agentChannel.findUnique({ where: { id: presence.id } }),
      ).toBeNull();
    });
  });
});

describe.skipIf(!PROOF_URL)("the app's own handle", () => {
  // The delete confirmation names the app a human would recognize in Slack
  // ("Slack app (@donna)"), so the handle has to be captured and stored. It
  // rides the `auth.test` completion already makes — no extra call.
  it("is captured from auth.test at completion", async () => {
    const agentId = await seedAgent("identity-name");
    scriptAuthTest("T111", "Acme", "UBOT", "donna");

    const presence = await agentChannels.completePresence(
      WORKSPACE,
      agentId,
      "slack",
      { botToken: "xoxb-d", appToken: "xapp-d", appId: "A-identity-name" },
      ADMIN,
    );

    const row = await db.agentChannel.findUnique({
      where: { id: presence.id },
      select: { identityName: true },
    });
    expect(row?.identityName).toBe("donna");
    await db.agent.delete({ where: { id: agentId } });
  });

  it("is backfilled for a presence that predates the column", async () => {
    const agentId = await seedAgent("identity-backfill");
    scriptAuthTest("T111", "Acme", "UBOT", "donna");
    const presence = await agentChannels.completePresence(
      WORKSPACE,
      agentId,
      "slack",
      { botToken: "xoxb-d", appToken: "xapp-d", appId: "A-identity-backfill" },
      ADMIN,
    );
    // Simulate an older row: completed before the column existed.
    await db.agentChannel.update({
      where: { id: presence.id },
      data: { identityName: null },
    });

    await agentChannels.getAgentChannels(WORKSPACE, agentId);

    const row = await db.agentChannel.findUnique({
      where: { id: presence.id },
      select: { identityName: true },
    });
    expect(row?.identityName).toBe("donna");
    await db.agent.delete({ where: { id: agentId } });
  });

  it("stays null when the provider omits it — the surface falls back to the app id", async () => {
    const agentId = await seedAgent("identity-none");
    // Not `scriptAuthTest(..., undefined)`: a default parameter cannot express
    // "the provider omitted this field", which is the case under test.
    slackHandlers["auth.test"] = () => ({
      ok: true,
      team_id: "T111",
      team: "Acme",
      user_id: "UBOT",
    });

    const presence = await agentChannels.completePresence(
      WORKSPACE,
      agentId,
      "slack",
      { botToken: "xoxb-d", appToken: "xapp-d", appId: "A-identity-none" },
      ADMIN,
    );

    const row = await db.agentChannel.findUnique({
      where: { id: presence.id },
      select: { identityName: true },
    });
    expect(row?.identityName).toBeNull();
    await db.agent.delete({ where: { id: agentId } });
  });
});

describe.skipIf(!PROOF_URL)(
  "deleting the AGENT tears its presences down",
  () => {
    // Deleting an agent used to cascade `AgentChannel` away and stop there,
    // leaving the Slack app installed in the customer's workspace and its
    // approvals service key live, with nothing in our database pointing at
    // either. The delete path runs the same teardown a detach does.
    const seedActivated = async (suffix: string) => {
      const agentId = await seedAgent(suffix);
      scriptAuthTest();
      const presence = await agentChannels.completePresence(
        WORKSPACE,
        agentId,
        "slack",
        { botToken: "xoxb-d", appToken: "xapp-d", appId: `A-${suffix}` },
        ADMIN,
      );
      await db.channelIntegration.updateMany({
        where: { organizationId: ORG, provider: "slack" },
        data: {
          credentials: await integrationCredentials(12 * 3600),
          credentialsRotatedAt: new Date(),
        },
      });
      return { agentId, presence };
    };

    it("asks Slack to delete the app and revokes the service key", async () => {
      const { agentId, presence } = await seedActivated("del-teardown");
      scriptRenameLands(presence.externalId);
      slackHandlers["apps.manifest.delete"] = () => ({ ok: true });

      const agentService = await import("../agent-service");
      await agentService.deleteAgent(WORKSPACE, agentId);

      const [deleteCall] = slackCallsFor("apps.manifest.delete");
      expect(deleteCall?.form.get("app_id")).toBe(presence.externalId);
      // The key row outlives the cascade (`onDelete: SetNull`), so an explicit
      // revoke is the only thing that stops it being a live credential.
      expect(
        await db.apiKey.findUnique({ where: { id: presence.apiKeyId! } }),
      ).toBeNull();
      expect(await db.agent.findUnique({ where: { id: agentId } })).toBeNull();
    });

    it("still deletes the agent when Slack refuses (best-effort by contract)", async () => {
      const { agentId, presence } = await seedActivated("del-refuse");
      scriptRenameLands(presence.externalId);
      slackHandlers["apps.manifest.delete"] = () => ({
        ok: false,
        error: "app_not_found",
      });

      const agentService = await import("../agent-service");
      await agentService.deleteAgent(WORKSPACE, agentId);

      // A revoked Slack credential must never make an agent undeletable.
      expect(slackCallsFor("apps.manifest.delete")).toHaveLength(1);
      expect(await db.agent.findUnique({ where: { id: agentId } })).toBeNull();
    });

    it("deletes an agent with no presence without calling Slack", async () => {
      const agentId = await seedAgent("del-nopresence");
      const before = slackCallsFor("apps.manifest.delete").length;

      const agentService = await import("../agent-service");
      await agentService.deleteAgent(WORKSPACE, agentId);

      expect(slackCallsFor("apps.manifest.delete")).toHaveLength(before);
      expect(await db.agent.findUnique({ where: { id: agentId } })).toBeNull();
    });

    // The console reported success while the app stayed installed, because the
    // whole teardown sat behind the org credential.
    it("STILL uninstalls with NO org config token — the app leaves the workspace", async () => {
      const { agentId, presence } = await seedActivated("del-noorg");
      await db.agentChannel.update({
        where: { id: presence.id },
        data: {
          credentials: await getCrypto().encrypt(
            JSON.stringify({
              botToken: "xoxb-d",
              clientId: "client-1",
              clientSecret: "client-secret-1",
            }),
          ),
        },
      });
      await db.channelIntegration.updateMany({
        where: { organizationId: ORG, provider: "slack" },
        data: { credentials: null, credentialsRotatedAt: null },
      });
      slackHandlers["apps.uninstall"] = () => ({ ok: true });
      const deletesBefore = slackCallsFor("apps.manifest.delete").length;

      const agentService = await import("../agent-service");
      await agentService.deleteAgent(WORKSPACE, agentId);

      const [uninstall] = slackCallsFor("apps.uninstall");
      expect(uninstall?.form.get("client_id")).toBe("client-1");
      expect(slackCallsFor("apps.manifest.delete")).toHaveLength(deletesBefore);
      expect(
        await db.apiKey.findUnique({ where: { id: presence.apiKeyId! } }),
      ).toBeNull();
      expect(await db.agent.findUnique({ where: { id: agentId } })).toBeNull();
    });
  },
);

describe.skipIf(!PROOF_URL)(
  "deleting the WORKSPACE tears its presences down",
  () => {
    // The offboarding path: removing a member deletes their personal workspaces,
    // which used to drop the agent rows and leave every employee's Slack app
    // installed in the workspace with nothing pointing at it.
    it("uninstalls each agent's app before the rows go", async () => {
      const agentId = await seedAgent("proj-teardown");
      scriptAuthTest();
      const presence = await agentChannels.completePresence(
        WORKSPACE,
        agentId,
        "slack",
        { botToken: "xoxb-d", appToken: "xapp-d", appId: "A-proj-teardown" },
        ADMIN,
      );
      await db.channelIntegration.updateMany({
        where: { organizationId: ORG, provider: "slack" },
        data: {
          credentials: await integrationCredentials(12 * 3600),
          credentialsRotatedAt: new Date(),
        },
      });
      scriptRenameLands(presence.externalId);
      slackHandlers["apps.manifest.delete"] = () => ({ ok: true });

      const channels = await import("./agent-channel-service");
      await channels.teardownWorkspacePresences(WORKSPACE);

      const [deleteCall] = slackCallsFor("apps.manifest.delete");
      expect(deleteCall?.form.get("app_id")).toBe(presence.externalId);
      expect(
        await db.apiKey.findUnique({ where: { id: presence.apiKeyId! } }),
      ).toBeNull();

      await db.agent.delete({ where: { id: agentId } });
    });

    it("is a no-op for a workspace whose agents have no apps", async () => {
      const agentId = await seedAgent("proj-noapps");
      const before = slackCallsFor("apps.manifest.delete").length;

      const channels = await import("./agent-channel-service");
      await channels.teardownWorkspacePresences(WORKSPACE);

      expect(slackCallsFor("apps.manifest.delete")).toHaveLength(before);
      await db.agent.delete({ where: { id: agentId } });
    });

    // The offboarding shape that failed in the wild: no org config token, so
    // the whole teardown threw before reaching Slack. Drives the real caller.
    it("STILL uninstalls the departing employee's app with NO org config token", async () => {
      const agentId = await seedAgent("proj-noorg");
      scriptAuthTest();
      const presence = await agentChannels.completePresence(
        WORKSPACE,
        agentId,
        "slack",
        { botToken: "xoxb-d", appToken: "xapp-d", appId: "A-proj-noorg" },
        ADMIN,
      );
      // The guided arm's client credentials, which the uninstall rides on.
      await db.agentChannel.update({
        where: { id: presence.id },
        data: {
          credentials: await getCrypto().encrypt(
            JSON.stringify({
              botToken: "xoxb-d",
              clientId: "client-1",
              clientSecret: "client-secret-1",
            }),
          ),
        },
      });
      // The failing configuration: no org token anywhere.
      await db.channelIntegration.updateMany({
        where: { organizationId: ORG, provider: "slack" },
        data: { credentials: null, credentialsRotatedAt: null },
      });
      slackHandlers["apps.uninstall"] = () => ({ ok: true });
      const deletesBefore = slackCallsFor("apps.manifest.delete").length;

      const channels = await import("./agent-channel-service");
      await channels.teardownWorkspacePresences(WORKSPACE);

      // The employee's bot leaves the workspace...
      const [uninstall] = slackCallsFor("apps.uninstall");
      expect(uninstall?.form.get("client_id")).toBe("client-1");
      // ...the app-record delete is skipped (it genuinely needs the org token)...
      expect(slackCallsFor("apps.manifest.delete")).toHaveLength(deletesBefore);
      // ...and the service key is still revoked, which is the security half.
      expect(
        await db.apiKey.findUnique({ where: { id: presence.apiKeyId! } }),
      ).toBeNull();

      await db.agent.delete({ where: { id: agentId } });
    });
  },
);

// ── The ingestion doors ─────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("ingestion — direct messages", () => {
  it("a linked member's DM becomes their per-user direct conversation + a stamped turn", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-happy");
    await linkUser(integrationId, "U111", MEMBER);

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U111", "D123", "hello agent"),
      eventId: "Ev-dm-1",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");

    const conversation = await db.conversation.findFirstOrThrow({
      where: { agentId },
    });
    expect(conversation.direct).toBe(true);
    expect(conversation.userId).toBe(MEMBER);
    expect(conversation.source).toBe("slack");

    const link = await db.channelThreadLink.findUniqueOrThrow({
      where: {
        agentChannelId_externalThreadId: {
          agentChannelId: presenceId,
          externalThreadId: "D123",
        },
      },
    });
    expect(link.conversationId).toBe(conversation.id);
    expect(link.kind).toBe("direct");
    expect(link.externalUserId).toBe("U111");

    const turn = await db.turn.findFirstOrThrow({
      where: { conversationId: conversation.id },
    });
    expect(turn.message).toBe("hello agent");
    // Stamped with the DOOR's origin and OUR authenticated user.
    expect(turn.source).toBe("slack");
    expect(turn.userId).toBe(MEMBER);
  });

  it("REDELIVERY of the same eventId is a no-op duplicate — no second turn", async () => {
    // MUTATION-TESTED: the dedupe is the insert-FIRST row in
    // channel_ingested_events. Delete the recordEventOnce insert (or move it
    // after the turn) and Slack's at-least-once redelivery posts the same
    // message twice — this test's turn count catches exactly that.
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-dupe");
    await linkUser(integrationId, "U111", MEMBER);
    const event = dmEvent("U111", "D123", "once please");

    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event,
      eventId: "Ev-dupe",
    });
    const second = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event,
      eventId: "Ev-dupe",
    });

    expect(second.kind).toBe("message");
    if (second.kind !== "message") throw new Error("unreachable");
    expect(second.outcome).toEqual({ kind: "duplicate" });
    expect(await db.turn.count({ where: { conversation: { agentId } } })).toBe(
      1,
    );
  });

  it("an agent-authored event is refused BEFORE the dedupe row is consumed", async () => {
    // The doors' own echo guard — defense-in-depth BEHIND interpret's drops
    // (this calls the door directly, exactly what a buggy adapter could do).
    // MUTATION-TESTED: delete the identityRef check in ingestDirectMessage
    // and the bot's own answer becomes a turn — the infinite loop.
    const { presenceId } = await seedChannelAgent("dm-echo");

    const outcome = await ingestion.ingestDirectMessage({
      agentChannelId: presenceId,
      externalUserId: "UBOT", // the presence's own identityRef
      externalThreadId: "D123",
      text: "my own answer",
      eventId: "Ev-echo",
    });

    expect(outcome).toEqual({ kind: "ignored", reason: "agent-authored" });
    // The identity check runs BEFORE recordEventOnce: no dedupe row burned,
    // so a real event reusing the id later is not misread as a duplicate.
    expect(
      await db.channelIngestedEvent.count({
        where: { agentChannelId: presenceId, eventId: "Ev-echo" },
      }),
    ).toBe(0);
    expect(
      await db.turn.count({
        where: { conversation: { agent: { identifier: { startsWith: P } } } },
      }),
    ).toBe(0);
  });

  it("re-linking a Slack user REPOINTS the thread link to the new user's conversation (secM3)", async () => {
    // MUTATION-TESTED (the upsert `update` clause): with the old no-op
    // `update: {}` the thread link keeps pointing at the OLD user's conversation
    // while the re-linked user's turns land in a different, unlinked one — and
    // the mirror then posts the OLD user's web activity into this DM (a
    // cross-user leak). The repoint makes the link FOLLOW the re-link.
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-repoint");
    await linkUser(integrationId, "U111", MEMBER);

    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U111", "D123", "as member"),
      eventId: "Ev-repoint-1",
    });
    const memberConv = await db.conversation.findFirstOrThrow({
      where: { agentId, userId: MEMBER },
      select: { id: true },
    });
    const threadKey = {
      agentChannelId_externalThreadId: {
        agentChannelId: presenceId,
        externalThreadId: "D123",
      },
    };
    expect(
      (await db.channelThreadLink.findUniqueOrThrow({ where: threadKey }))
        .conversationId,
    ).toBe(memberConv.id);

    // Free the one-active-turn slot (fenced to this suite's agents).
    await db.turn.updateMany({
      where: { conversation: { agent: { identifier: { startsWith: P } } } },
      data: { status: "done", finishedAt: new Date() },
    });

    // An admin re-maps the SAME Slack user id to a DIFFERENT platform member.
    await db.channelUserLink.update({
      where: {
        integrationId_externalUserId: { integrationId, externalUserId: "U111" },
      },
      data: { userId: CTRL_NAME_USER },
    });

    const second = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U111", "D123", "as the new user"),
      eventId: "Ev-repoint-2",
    });
    expect(second.kind).toBe("message");
    if (second.kind !== "message") throw new Error("unreachable");
    expect(second.outcome.kind).toBe("turn");

    const newConv = await db.conversation.findFirstOrThrow({
      where: { agentId, userId: CTRL_NAME_USER },
      select: { id: true },
    });
    expect(newConv.id).not.toBe(memberConv.id);

    // The link FOLLOWED the re-link to the new user's conversation...
    expect(
      (await db.channelThreadLink.findUniqueOrThrow({ where: threadKey }))
        .conversationId,
    ).toBe(newConv.id);

    // ...and the second turn landed in the NEW user's conversation.
    const turn = await db.turn.findFirstOrThrow({
      where: { conversationId: newConv.id },
    });
    expect(turn.message).toBe("as the new user");
    expect(turn.userId).toBe(CTRL_NAME_USER);
  });

  it("an unmapped user is refused NOT-LINKED — no turn, no conversation", async () => {
    const { agentId, presenceId } = await seedChannelAgent("dm-unmapped");

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U404", "D404", "who am I"),
      eventId: "Ev-unmapped",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("refused");
    if (result.outcome.kind !== "refused") throw new Error("unreachable");
    expect(result.outcome.message).toContain("couldn't match");
    expect(await db.conversation.count({ where: { agentId } })).toBe(0);
    expect(await db.turn.count({ where: { conversation: { agentId } } })).toBe(
      0,
    );
  });

  it("runs the lazy users.info lookup with the presence's own bot token", async () => {
    const { presenceId } = await seedChannelAgent("dm-lookup", {
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-lookup" }),
      ),
    });
    slackHandlers["users.info"] = () => ({
      ok: true,
      user: { id: "U404", profile: {} }, // known user, NO email → not linkable
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U404", "D404", "hi"),
      eventId: "Ev-lookup",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("refused");
    const [lookup] = slackCallsFor("users.info");
    expect(lookup?.token).toBe("xoxb-lookup");
    expect(lookup?.form.get("user")).toBe("U404");
  });

  it("a matched email who is NOT an org member: NO link minted, refused as not-linked", async () => {
    // Only a live org member earns an email link (fixed 2026-08-07): minting
    // first left residue for outsiders whose email happened to match, and
    // turned their actionable "not linked" refusal into a puzzling "no
    // access". MUTATION-TESTED twice over: delete the eligibility check
    // before the mint and the link assertion fails; delete the
    // organizationMember fence itself and this becomes a turn for a user
    // nobody let in.
    //
    // The email is now resolved CONTROL-PLANE-SIDE via the presence's own bot
    // token (users.info) — never from the caller. The outsider's email lands
    // through that lookup, and the membership fence still refuses.
    const { agentId, integrationId, presenceId } = await seedChannelAgent(
      "dm-outsider",
      {
        presenceCredentials: await getCrypto().encrypt(
          JSON.stringify({ botToken: "xoxb-outsider" }),
        ),
      },
    );
    slackHandlers["users.info"] = () => ({
      ok: true,
      user: { id: "U500", profile: { email: `${OUTSIDER}@example.com` } },
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U500", "D500", "let me in"),
      eventId: "Ev-outsider",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("refused");
    if (result.outcome.kind !== "refused") throw new Error("unreachable");
    // No residue, and the refusal is the "not linked" flavor — the one that
    // names the fix an admin can actually make.
    expect(result.outcome.message).toContain("couldn't match");
    const link = await db.channelUserLink.findUnique({
      where: {
        integrationId_externalUserId: {
          integrationId,
          externalUserId: "U500",
        },
      },
    });
    expect(link).toBeNull();
    expect(await db.turn.count({ where: { conversation: { agentId } } })).toBe(
      0,
    );
  });

  it("a SUSPENDED member's link no longer authorizes — refused, no turn", async () => {
    // MUTATION-TESTED: pins `NOT: { status: "suspended" }` in the membership
    // fence — delete it and a deprovisioned employee keeps talking to the
    // agent through Slack. (The RBAC workspace-access arm is covered by
    // canAccessWorkspaceAsUser's own suite; onprem answers true there.)
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-suspended");
    await linkUser(integrationId, "U600", SUSPENDED);

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U600", "D600", "still me"),
      eventId: "Ev-suspended",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("refused");
    if (result.outcome.kind !== "refused") throw new Error("unreachable");
    expect(result.outcome.message).toContain("doesn't have access");
    expect(await db.turn.count({ where: { conversation: { agentId } } })).toBe(
      0,
    );
  });

  it("accepts a mid-run message as a FOLLOW-UP while a turn is in flight — never a silent busy drop", async () => {
    // The exact drop this feature killed: the old door burned the dedupe row
    // and answered `busy` with a text promise nothing honored — the message
    // text was persisted nowhere. Now it lands as a `joining` row targeting
    // the live turn, verbatim, and its ack is the receipt reaction moving.
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("dm-busy");
    await linkUser(integrationId, "U111", MEMBER);

    const first = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U111", "D123", "first"),
      eventId: "Ev-busy-1",
    });
    expect(first.kind === "message" && first.outcome.kind).toBe("turn");

    const second = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U111", "D123", "second"),
      eventId: "Ev-busy-2",
    });

    expect(second.kind).toBe("message");
    if (second.kind !== "message") throw new Error("unreachable");
    expect(second.outcome.kind).toBe("followUp");
    if (second.outcome.kind !== "followUp") throw new Error("unreachable");
    expect(second.outcome.turn.status).toBe("joining");
    expect(second.outcome.turn.message).toBe("second");
    // Durably recorded, targeting the live turn — nothing to lose.
    const rows = await db.turn.findMany({
      where: { conversation: { agentId } },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]?.followUpOfTurnId).toBe(rows[0]?.id);
  });

  it("refuses at the follow-up cap VISIBLY — message #N+1 must never vanish", async () => {
    const { integrationId, presenceId } = await seedChannelAgent("dm-cap");
    await linkUser(integrationId, "U111", MEMBER);
    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U111", "D123", "the running one"),
      eventId: "Ev-cap-0",
    });
    for (let i = 0; i < validations.MAX_JOINING_FOLLOW_UPS; i += 1) {
      const accepted = await dispatch.dispatchSlackEvent({
        presenceId,
        identityRef: "UBOT",
        event: dmEvent("U111", "D123", `follow-up ${i}`),
        eventId: `Ev-cap-${i + 1}`,
      });
      expect(accepted.kind === "message" && accepted.outcome.kind).toBe(
        "followUp",
      );
    }

    const over = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U111", "D123", "one too many"),
      eventId: "Ev-cap-over",
    });

    expect(over.kind).toBe("message");
    if (over.kind !== "message") throw new Error("unreachable");
    // `refused` posts a reply on both arms — visible, unlike the old drop.
    expect(over.outcome.kind).toBe("refused");
    if (over.outcome.kind !== "refused") throw new Error("unreachable");
    expect(over.outcome.message).toBe(validations.FOLLOW_UP_CAP_MESSAGE);
  });

  it("a keyless agent fails the turn with errorCode no_model_key", async () => {
    const { integrationId, presenceId } = await seedChannelAgent("dm-nokey", {
      withoutKey: true,
    });
    await linkUser(integrationId, "U111", MEMBER);

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U111", "D123", "anyone home"),
      eventId: "Ev-nokey",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");
    if (result.outcome.kind !== "turn") throw new Error("unreachable");
    expect(result.outcome.turn.status).toBe("failed");
    expect(result.outcome.turn.errorCode).toBe("no_model_key");
  });
});

describe.skipIf(!PROOF_URL)("ingestion — attachments (file_share)", () => {
  /** A presence carrying an encrypted bot token — what fetchAttachment needs
   * to authenticate the url_private download. */
  const botCredentials = () =>
    getCrypto().encrypt(
      JSON.stringify({
        clientId: "c",
        clientSecret: "s",
        signingSecret: "sig",
        botToken: "xoxb-att-bot",
      }),
    );

  /** A DM whose message shares files — Slack's `file_share` subtype. */
  const fileShareEvent = (
    user: string,
    channel: string,
    text: string,
    files: Record<string, unknown>[],
  ) => ({
    type: "message",
    channel_type: "im",
    channel,
    user,
    subtype: "file_share",
    text,
    files,
    ts: "1000.0002",
  });

  const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
  ]);

  const scriptFileDownload = (path: string, bytes: Buffer, type: string) => {
    slackHandlers[path] = () => ({
      __binary: { bytes, contentType: type },
    });
  };

  const fileDownloadCalls = () =>
    slackCalls.filter((c) => c.method.startsWith("files-pri/"));

  it("downloads the file with the BOT token, stores it, and binds it to the turn in one commit", async () => {
    const { agentId, integrationId, presenceId } = await seedChannelAgent(
      "att-happy",
      { presenceCredentials: await botCredentials() },
    );
    await linkUser(integrationId, "U111", MEMBER);
    const slackUrl = process.env.SLACK_API_BASE_URL;
    scriptFileDownload("files-pri/T1-F1/photo.png", PNG_BYTES, "image/png");

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: fileShareEvent("U111", "D900", "what is this?", [
        {
          id: "F1",
          name: "photo.png",
          mimetype: "image/png",
          size: PNG_BYTES.byteLength,
          url_private: `${slackUrl}/files-pri/T1-F1/photo.png`,
        },
      ]),
      eventId: "Ev-att-1",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");

    // The download carried the presence's bot token — files:read's subject.
    const download = fileDownloadCalls().at(-1);
    expect(download?.token).toMatch(/^xoxb-/);

    const turn = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId } },
    });
    // The person's words stay verbatim — the attachment rides rows, never
    // prose injected into the stored message.
    expect(turn.message).toBe("what is this?");

    const attachment = await db.conversationAttachment.findFirstOrThrow({
      where: { turnId: turn.id },
    });
    expect(attachment.status).toBe("bound");
    expect(attachment.name).toBe("photo.png");
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.sizeBytes).toBe(PNG_BYTES.byteLength);
    expect(Buffer.from(attachment.data ?? []).equals(PNG_BYTES)).toBe(true);
    expect(attachment.userId).toBe(MEMBER);
    expect(attachment.source).toBe("slack");
  });

  it("an UNAUTHORIZED speaker's files are NEVER fetched — refusal precedes the download", async () => {
    // MUTATION-TESTED (order): move ingestMessageFiles above authorizeSpeaker
    // in ingestDirectMessage and this zero-download assertion fails — an
    // unlinked stranger could then make the platform fetch (and store)
    // arbitrary bytes with the workspace's bot token.
    const { presenceId } = await seedChannelAgent("att-unauth", {
      presenceCredentials: await botCredentials(),
    });
    const slackUrl = process.env.SLACK_API_BASE_URL;
    scriptFileDownload("files-pri/T1-F9/evil.png", PNG_BYTES, "image/png");

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: fileShareEvent("U999", "D901", "look at this", [
        {
          id: "F9",
          name: "evil.png",
          mimetype: "image/png",
          size: 8,
          url_private: `${slackUrl}/files-pri/T1-F9/evil.png`,
        },
      ]),
      eventId: "Ev-att-unauth",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("refused");
    expect(fileDownloadCalls()).toEqual([]);
    expect(await db.conversationAttachment.count()).toBe(0);
  });

  it("a KNOWN-oversize file is refused from metadata — failed row, zero bytes fetched, turn still lands", async () => {
    const { agentId, integrationId, presenceId } = await seedChannelAgent(
      "att-oversize",
      { presenceCredentials: await botCredentials() },
    );
    await linkUser(integrationId, "U111", MEMBER);
    const slackUrl = process.env.SLACK_API_BASE_URL;

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: fileShareEvent("U111", "D902", "big one", [
        {
          id: "F2",
          name: "huge.mov",
          mimetype: "video/quicktime",
          size: 900 * 1024 * 1024,
          url_private: `${slackUrl}/files-pri/T1-F2/huge.mov`,
        },
      ]),
      eventId: "Ev-att-big",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");
    expect(fileDownloadCalls()).toEqual([]);

    const attachment = await db.conversationAttachment.findFirstOrThrow({
      where: { conversation: { agentId } },
    });
    expect(attachment.status).toBe("failed");
    expect(attachment.error).toContain("too large");
    expect(attachment.turnId).not.toBeNull();
    expect(attachment.data).toBeNull();
  });

  it("an HTML answer (Slack's login page — the missing files:read shape) is a failed row, never stored as the file", async () => {
    const { agentId, integrationId, presenceId } = await seedChannelAgent(
      "att-html",
      { presenceCredentials: await botCredentials() },
    );
    await linkUser(integrationId, "U111", MEMBER);
    const slackUrl = process.env.SLACK_API_BASE_URL;
    scriptFileDownload(
      "files-pri/T1-F3/photo.png",
      Buffer.from("<html>sign in to Slack</html>"),
      "text/html; charset=utf-8",
    );

    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: fileShareEvent("U111", "D903", "here", [
        {
          id: "F3",
          name: "photo.png",
          mimetype: "image/png",
          size: 8,
          url_private: `${slackUrl}/files-pri/T1-F3/photo.png`,
        },
      ]),
      eventId: "Ev-att-html",
    });

    const attachment = await db.conversationAttachment.findFirstOrThrow({
      where: { conversation: { agentId } },
    });
    expect(attachment.status).toBe("failed");
    expect(attachment.error).toContain("files:read");
    expect(attachment.data).toBeNull();
  });

  it("a HOSTILE url_private (non-Slack host) is refused WITHOUT any request — the bot token never leaves", async () => {
    // The SSRF/token-exfiltration fence: url_private arrives inside the
    // event payload (attacker-influencable through the adapter-token trust
    // boundary), and the Authorization header carries the workspace's bot
    // token. MUTATION-TESTED: drop the isSlackFilesUrl pin in
    // downloadPrivateFile and this becomes a live outbound fetch.
    const { agentId, integrationId, presenceId } = await seedChannelAgent(
      "att-ssrf",
      { presenceCredentials: await botCredentials() },
    );
    await linkUser(integrationId, "U111", MEMBER);

    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: fileShareEvent("U111", "D904", "fetch this", [
        {
          id: "F4",
          name: "meta.txt",
          mimetype: "text/plain",
          size: 8,
          url_private: "http://169.254.169.254/latest/meta-data/",
        },
      ]),
      eventId: "Ev-att-ssrf",
    });

    expect(fileDownloadCalls()).toEqual([]);
    const attachment = await db.conversationAttachment.findFirstOrThrow({
      where: { conversation: { agentId } },
    });
    expect(attachment.status).toBe("failed");
    expect(attachment.error).toContain("non-Slack");
  });

  it("a CDN redirect (Slack's non-image shape) is followed WITHOUT the token — PDF lands, bot token never reaches the CDN", async () => {
    // Slack 302s every authenticated non-image `files-pri` download to its
    // presigned safe-files CDN (slack-files.com) — a DIFFERENT registrable
    // domain, refused by the pre-fix pin, which is exactly why PDFs failed
    // while inline-served images worked. MUTATION-TESTED (both directions):
    // keep sending the Authorization header on the CDN hop and the
    // no-token assertion fails — the exfiltration fence is the point.
    const { agentId, integrationId, presenceId } = await seedChannelAgent(
      "att-cdn",
      { presenceCredentials: await botCredentials() },
    );
    await linkUser(integrationId, "U111", MEMBER);
    const slackUrl = process.env.SLACK_API_BASE_URL;
    const cdnUrl = process.env.SLACK_CDN_BASE_URL;
    const PDF_BYTES = Buffer.from("%PDF-1.4 tiny bill");
    slackHandlers["files-pri/T1-F8/bill.pdf"] = () => ({
      __redirect: `${cdnUrl}/files-pri-safe/T1-F8/bill.pdf?c=1234`,
    });
    cdnHandlers["files-pri-safe/T1-F8/bill.pdf?c=1234"] = () => ({
      bytes: PDF_BYTES,
      contentType: "application/pdf",
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: fileShareEvent("U111", "D907", "whats in there?", [
        {
          id: "F8",
          name: "bill.pdf",
          mimetype: "application/pdf",
          size: PDF_BYTES.byteLength,
          url_private: `${slackUrl}/files-pri/T1-F8/bill.pdf`,
        },
      ]),
      eventId: "Ev-att-cdn",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");

    // The Slack-host hop carried the bot token (files:read's subject)...
    const slackHop = fileDownloadCalls().at(-1);
    expect(slackHop?.token).toMatch(/^xoxb-/);
    // ...and the CDN hop carried NO Authorization header at all: the
    // presigned URL is its own credential, and the bot token must never
    // travel beyond isSlackFilesUrl hosts.
    expect(cdnCalls).toHaveLength(1);
    expect(cdnCalls[0]?.authorization).toBeNull();

    const attachment = await db.conversationAttachment.findFirstOrThrow({
      where: { conversation: { agentId } },
    });
    expect(attachment.status).toBe("bound");
    expect(attachment.name).toBe("bill.pdf");
    expect(attachment.mimeType).toBe("application/pdf");
    expect(Buffer.from(attachment.data ?? []).equals(PDF_BYTES)).toBe(true);
  });

  it("a redirect to a host on NEITHER list (Slack nor its CDN) is refused without a request", async () => {
    // The open-redirect arm of the SSRF fence: the INITIAL url passes the
    // Slack pin, but the redirect target is an arbitrary third origin. The
    // CDN allowance must not widen into follow-anything — zero requests
    // reach the rogue host, tokenless or otherwise. MUTATION-TESTED: replace
    // the isSlackCdnUrl check with `true` and the zero-hit assertion fails.
    const { agentId, integrationId, presenceId } = await seedChannelAgent(
      "att-rogue-redirect",
      { presenceCredentials: await botCredentials() },
    );
    await linkUser(integrationId, "U111", MEMBER);
    const slackUrl = process.env.SLACK_API_BASE_URL;
    let rogueHits = 0;
    const rogue = createServer((_req, res) => {
      rogueHits += 1;
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("stolen");
    });
    await new Promise<void>((resolve) =>
      rogue.listen(0, "127.0.0.1", () => resolve()),
    );
    const roguePort = (rogue.address() as AddressInfo).port;
    try {
      slackHandlers["files-pri/T1-FA/evil.pdf"] = () => ({
        __redirect: `http://127.0.0.1:${roguePort}/anywhere`,
      });

      await dispatch.dispatchSlackEvent({
        presenceId,
        identityRef: "UBOT",
        event: fileShareEvent("U111", "D908", "fetch", [
          {
            id: "FA",
            name: "evil.pdf",
            mimetype: "application/pdf",
            size: 8,
            url_private: `${slackUrl}/files-pri/T1-FA/evil.pdf`,
          },
        ]),
        eventId: "Ev-att-rogue",
      });

      expect(rogueHits).toBe(0);
      const attachment = await db.conversationAttachment.findFirstOrThrow({
        where: { conversation: { agentId } },
      });
      expect(attachment.status).toBe("failed");
      expect(attachment.error).toContain("non-Slack");
    } finally {
      await new Promise((resolve) => rogue.close(resolve));
    }
  });

  it("REDELIVERY dedupe also bounds the download — one fetch, one row", async () => {
    const { agentId, integrationId, presenceId } = await seedChannelAgent(
      "att-dupe",
      { presenceCredentials: await botCredentials() },
    );
    await linkUser(integrationId, "U111", MEMBER);
    const slackUrl = process.env.SLACK_API_BASE_URL;
    scriptFileDownload("files-pri/T1-F5/once.png", PNG_BYTES, "image/png");
    const event = fileShareEvent("U111", "D905", "once", [
      {
        id: "F5",
        name: "once.png",
        mimetype: "image/png",
        size: PNG_BYTES.byteLength,
        url_private: `${slackUrl}/files-pri/T1-F5/once.png`,
      },
    ]);

    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event,
      eventId: "Ev-att-once",
    });
    const second = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event,
      eventId: "Ev-att-once",
    });

    if (second.kind !== "message") throw new Error("unreachable");
    expect(second.outcome).toEqual({ kind: "duplicate" });
    expect(fileDownloadCalls()).toHaveLength(1);
    expect(
      await db.conversationAttachment.count({
        where: { conversation: { agentId } },
      }),
    ).toBe(1);
  });

  it("a file-only message (no words) still becomes a turn carrying its attachment", async () => {
    const { agentId, integrationId, presenceId } = await seedChannelAgent(
      "att-wordless",
      { presenceCredentials: await botCredentials() },
    );
    await linkUser(integrationId, "U111", MEMBER);
    const slackUrl = process.env.SLACK_API_BASE_URL;
    scriptFileDownload("files-pri/T1-F6/mute.png", PNG_BYTES, "image/png");

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: fileShareEvent("U111", "D906", "", [
        {
          id: "F6",
          name: "mute.png",
          mimetype: "image/png",
          size: PNG_BYTES.byteLength,
          url_private: `${slackUrl}/files-pri/T1-F6/mute.png`,
        },
      ]),
      eventId: "Ev-att-mute",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");
    const turn = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId } },
    });
    expect(turn.message).toBe("");
    expect(
      await db.conversationAttachment.count({ where: { turnId: turn.id } }),
    ).toBe(1);
  });

  it("MORE than the deliverable cap: the message still lands, surplus files marked failed", async () => {
    // REGRESSION (found in review): the over-cap arm minted a `failed` row per
    // surplus file and pushed every id into the bind, whose guard was the
    // DELIVERABLE cap — so a 6-file message threw inside the turn-create
    // transaction and the whole message vanished, text included. The bind now
    // caps only what is actually delivered; byteless rows ride along.
    const { agentId, integrationId, presenceId } = await seedChannelAgent(
      "att-overcap",
      { presenceCredentials: await botCredentials() },
    );
    await linkUser(integrationId, "U111", MEMBER);
    const slackUrl = process.env.SLACK_API_BASE_URL;
    const files = Array.from({ length: 7 }, (_, i) => {
      scriptFileDownload(
        `files-pri/T1-FC${i}/f${i}.png`,
        PNG_BYTES,
        "image/png",
      );
      return {
        id: `FC${i}`,
        name: `f${i}.png`,
        mimetype: "image/png",
        size: PNG_BYTES.byteLength,
        url_private: `${slackUrl}/files-pri/T1-FC${i}/f${i}.png`,
      };
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: fileShareEvent("U111", "D910", "seven files", files),
      eventId: "Ev-att-overcap",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    // The message SURVIVES — this is the whole point of the regression.
    expect(result.outcome.kind).toBe("turn");
    const turn = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId } },
    });
    expect(turn.message).toBe("seven files");

    const rows = await db.conversationAttachment.findMany({
      where: { turnId: turn.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(7);
    expect(rows.filter((r) => r.status === "bound")).toHaveLength(5);
    const refused = rows.filter((r) => r.status === "failed");
    expect(refused).toHaveLength(2);
    expect(refused[0]?.error).toContain("5-file limit");
    // Only the deliverable ones were fetched.
    expect(fileDownloadCalls()).toHaveLength(5);
  });

  it("a Slack Connect stub (check_file_info) resolves through files.info before downloading", async () => {
    const { agentId, integrationId, presenceId } = await seedChannelAgent(
      "att-stub",
      { presenceCredentials: await botCredentials() },
    );
    await linkUser(integrationId, "U111", MEMBER);
    const slackUrl = process.env.SLACK_API_BASE_URL;
    slackHandlers["files.info"] = () => ({
      ok: true,
      file: {
        id: "F7",
        name: "shared.png",
        mimetype: "image/png",
        size: PNG_BYTES.byteLength,
        url_private: `${slackUrl}/files-pri/T1-F7/shared.png`,
      },
    });
    scriptFileDownload("files-pri/T1-F7/shared.png", PNG_BYTES, "image/png");

    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: fileShareEvent("U111", "D907", "from connect", [
        { id: "F7", mode: "file_access", file_access: "check_file_info" },
      ]),
      eventId: "Ev-att-stub",
    });

    expect(slackCallsFor("files.info")).toHaveLength(1);
    const attachment = await db.conversationAttachment.findFirstOrThrow({
      where: { conversation: { agentId } },
    });
    expect(attachment.status).toBe("bound");
    expect(attachment.name).toBe("shared.png");
  });
});

describe.skipIf(!PROOF_URL)("ingestion — group surfaces", () => {
  it("a mention starts a sourced conversation; the speaker prefix uses the CLEANED platform name", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("grp-mention");
    await linkUser(integrationId, "U222", CTRL_NAME_USER);
    await settleChannel(agentId, integrationId, "C1");

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: mentionEvent("U222", "C1", "111.222", "<@UBOT> deploy please"),
      eventId: "Ev-grp-1",
    });

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");

    const conversation = await db.conversation.findFirstOrThrow({
      where: { agentId },
    });
    expect(conversation.direct).toBe(false);
    expect(conversation.source).toBe("slack");
    // The group-thread address: the THREAD, not the channel.
    expect(conversation.externalRef).toBe("C1:111.222");

    const link = await db.channelThreadLink.findUniqueOrThrow({
      where: {
        agentChannelId_externalThreadId: {
          agentChannelId: presenceId,
          externalThreadId: "C1:111.222",
        },
      },
    });
    expect(link.kind).toBe("group");
    expect(link.externalUserId).toBeNull();

    const turn = await db.turn.findFirstOrThrow({
      where: { conversationId: conversation.id },
    });
    // MUTATION-TESTED: the speaker prefix is OUR user's name run through
    // cleanName — the stored name is "Bad\x07Name\x1b". Delete the
    // control-char strip and the raw escape bytes land inside the turn
    // message (a terminal-escape / prompt-surface hazard).
    expect(turn.message).toBe("BadName: <@UBOT> deploy please");
    expect(turn.userId).toBe(CTRL_NAME_USER);
    expect(turn.source).toBe("slack");
  });

  it("a thread FOLLOW-UP (no mention) counts once the thread is linked, and reuses the conversation", async () => {
    const { agentId, integrationId, presenceId } =
      await seedChannelAgent("grp-follow");
    await linkUser(integrationId, "U111", MEMBER);
    await settleChannel(agentId, integrationId, "C1");

    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: mentionEvent("U111", "C1", "111.222", "<@UBOT> start"),
      eventId: "Ev-follow-1",
    });
    // Free the one-active-turn slot before the follow-up. Fenced to THIS
    // suite's agents — pg suites share one database in parallel, and an
    // unfenced updateMany here flipped OTHER suites' in-flight turns to
    // "done" mid-assertion (caught as cross-suite flakes in the full run).
    await db.turn.updateMany({
      where: { conversation: { agent: { identifier: { startsWith: P } } } },
      data: { status: "done", finishedAt: new Date() },
    });

    const followUp = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U111",
        text: "and another thing",
        ts: "111.900",
        thread_ts: "111.222",
      },
      eventId: "Ev-follow-2",
    });

    expect(followUp.kind).toBe("message");
    if (followUp.kind !== "message") throw new Error("unreachable");
    expect(followUp.outcome.kind).toBe("turn");
    // Same thread → same conversation, not a second one.
    expect(await db.conversation.count({ where: { agentId } })).toBe(1);
  });

  it("chatter in an UNJOINED thread is ignored without touching the doors", async () => {
    const { presenceId } = await seedChannelAgent("grp-unjoined");

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U111",
        text: "not for the agent",
        ts: "222.900",
        thread_ts: "222.100",
      },
      eventId: "Ev-unjoined",
    });

    expect(result).toEqual({
      kind: "ignored",
      reason: "unjoined-thread-chatter",
    });
    // Ignored means IGNORED: not even a dedupe row was spent.
    expect(
      await db.channelIngestedEvent.count({
        where: { agentChannelId: presenceId },
      }),
    ).toBe(0);
  });
});

describe.skipIf(!PROOF_URL)("ingestion — group invites", () => {
  const inviteEvent = (inviter?: string) => ({
    type: "member_joined_channel",
    channel: "C7",
    user: "UBOT",
    ...(inviter && { inviter }),
  });

  it("accepts an invite from an authorized member", async () => {
    const { integrationId, presenceId } = await seedChannelAgent("inv-ok");
    await linkUser(integrationId, "U111", MEMBER);

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: inviteEvent("U111"),
      eventId: "Ev-inv-ok",
    });

    expect(result.kind).toBe("invite");
    if (result.kind !== "invite") throw new Error("unreachable");
    expect(result.outcome).toEqual({ kind: "accept" });
  });

  it("REFUSES an invite from an unauthorized inviter and STAYS MUTED (leave: false)", async () => {
    // Refuse-and-stay-muted (docs-verified 2026-08-07): exiting a channel
    // needs channels:manage/groups:write, scopes the manifest deliberately
    // never requests — so the door answers `leave: false` and the refusal
    // copy tells people the bot stays muted and how to remove it.
    // MUTATION-TESTED: flip the door back to leave:true (or drop the
    // appended copy) and these assertions fail — with leave:true on the
    // wire, the adapter would try an exit that missing_scope refuses.
    const { presenceId } = await seedChannelAgent("inv-stranger");

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: inviteEvent("U404"),
      eventId: "Ev-inv-stranger",
    });

    expect(result.kind).toBe("invite");
    if (result.kind !== "invite") throw new Error("unreachable");
    expect(result.outcome).toMatchObject({ kind: "refuse", leave: false });
    if (result.outcome.kind !== "refuse") throw new Error("unreachable");
    // The refusal itself, PLUS the stay-muted coda.
    expect(result.outcome.message).toContain("couldn't match");
    expect(result.outcome.message).toContain(
      "I'll stay muted in this channel. Anyone can remove me from it.",
    );
  });

  it("an UNKNOWN inviter fails closed — refused, muted, never left", async () => {
    const { presenceId } = await seedChannelAgent("inv-unknown");

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: inviteEvent(),
      eventId: "Ev-inv-unknown",
    });

    expect(result.kind).toBe("invite");
    if (result.kind !== "invite") throw new Error("unreachable");
    expect(result.outcome).toMatchObject({ kind: "refuse", leave: false });
    if (result.outcome.kind !== "refuse") throw new Error("unreachable");
    expect(result.outcome.message).toContain(
      "I'll stay muted in this channel. Anyone can remove me from it.",
    );
  });

  it("a REDELIVERED invite is a duplicate", async () => {
    const { integrationId, presenceId } = await seedChannelAgent("inv-dupe");
    await linkUser(integrationId, "U111", MEMBER);

    await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: inviteEvent("U111"),
      eventId: "Ev-inv-dupe",
    });
    const second = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: inviteEvent("U111"),
      eventId: "Ev-inv-dupe",
    });

    expect(second.kind).toBe("invite");
    if (second.kind !== "invite") throw new Error("unreachable");
    expect(second.outcome).toEqual({ kind: "duplicate" });
  });
});

// ── The adapter service ─────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("registerAdapter (the anchor law)", () => {
  it("REFUSES an unknown token that is not the instance anchor", async () => {
    // MUTATION-TESTED: delete the anchor comparison (accept any cha_ token)
    // and this fails — an attacker-minted token would become a credential
    // that reads every presence's decrypted secrets from /config.
    expect(
      await adapters.registerAdapter({
        token: `cha_${P}attacker-supplied`,
        name: "evil",
      }),
    ).toEqual({ ok: false });
    expect(
      await db.channelAdapter.count({
        where: { token: { startsWith: `cha_${P}` } },
      }),
    ).toBe(0);
  });

  it("refuses a token that merely prefixes or extends the anchor", async () => {
    expect(
      await adapters.registerAdapter({
        token: ADAPTER_ANCHOR.slice(0, -1),
        name: "close",
      }),
    ).toEqual({ ok: false });
    expect(
      await adapters.registerAdapter({
        token: `${ADAPTER_ANCHOR}x`,
        name: "closer",
      }),
    ).toEqual({ ok: false });
  });

  it("creates the row for the exact anchor, and re-registration updates it in place", async () => {
    const first = await adapters.registerAdapter({
      token: ADAPTER_ANCHOR,
      name: "adapter-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");

    const before = await db.channelAdapter.findUniqueOrThrow({
      where: { id: first.adapterId },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const again = await adapters.registerAdapter({
      token: ADAPTER_ANCHOR,
      name: "adapter-1-restarted",
    });
    expect(again).toEqual({ ok: true, adapterId: first.adapterId });
    expect(
      await db.channelAdapter.count({
        where: { token: { startsWith: `cha_${P}` } },
      }),
    ).toBe(1);
    const after = await db.channelAdapter.findUniqueOrThrow({
      where: { id: first.adapterId },
    });
    expect(after.name).toBe("adapter-1-restarted");
    expect(after.lastSeenAt!.getTime()).toBeGreaterThan(
      before.lastSeenAt!.getTime(),
    );
  });
});

describe.skipIf(!PROOF_URL)("registerAdapter (the per-instance mint)", () => {
  it("mints a per-instance credential — the anchor proves membership, never becomes the row", async () => {
    const result = await adapters.registerAdapter({
      token: ADAPTER_ANCHOR,
      name: `${P}mint-1`,
      perInstance: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.mintedToken).toMatch(/^cha_[0-9a-f]{64}$/);
    expect(result.mintedToken).not.toBe(ADAPTER_ANCHOR);

    const row = await db.channelAdapter.findUniqueOrThrow({
      where: { id: result.adapterId },
    });
    expect(row.kind).toBe("instance");
    expect(row.token).toBe(result.mintedToken);
    // The anchor itself was never stored: no anchor-token row exists.
    expect(
      await db.channelAdapter.count({ where: { token: ADAPTER_ANCHOR } }),
    ).toBe(0);
  });

  it("REFUSES a mint request whose token is not the anchor", async () => {
    expect(
      await adapters.registerAdapter({
        token: `cha_${P}not-the-anchor`,
        name: `${P}mint-evil`,
        perInstance: true,
      }),
    ).toEqual({ ok: false });
  });

  it("a same-name re-register STEALS the row: same adapterId, fresh token, old token dead", async () => {
    const first = await adapters.registerAdapter({
      token: ADAPTER_ANCHOR,
      name: `${P}mint-steal`,
      perInstance: true,
    });
    if (!first.ok) throw new Error("unreachable");
    const again = await adapters.registerAdapter({
      token: ADAPTER_ANCHOR,
      name: `${P}mint-steal`,
      perInstance: true,
    });
    if (!again.ok) throw new Error("unreachable");

    // The identity (and every ownership lease keyed on it) survives the
    // restart; the displaced credential does not.
    expect(again.adapterId).toBe(first.adapterId);
    expect(again.mintedToken).not.toBe(first.mintedToken);
    expect(
      await db.channelAdapter.count({ where: { token: first.mintedToken } }),
    ).toBe(0);
    expect(
      await db.channelAdapter.count({ where: { name: `${P}mint-steal` } }),
    ).toBe(1);
  });

  it("never cannibalizes an ANCHOR row that happens to share the name", async () => {
    // MUTATION-TESTED: drop the `kind: "instance"` filter from the steal
    // lookup and the mint below rotates the legacy shared row's token —
    // every old binary presenting the anchor 401s from that moment on.
    const legacy = await adapters.registerAdapter({
      token: ADAPTER_ANCHOR,
      name: `${P}mint-shared`,
    });
    if (!legacy.ok) throw new Error("unreachable");

    const minted = await adapters.registerAdapter({
      token: ADAPTER_ANCHOR,
      name: `${P}mint-shared`,
      perInstance: true,
    });
    if (!minted.ok) throw new Error("unreachable");

    expect(minted.adapterId).not.toBe(legacy.adapterId);
    const legacyRow = await db.channelAdapter.findUniqueOrThrow({
      where: { id: legacy.adapterId },
    });
    expect(legacyRow.token).toBe(ADAPTER_ANCHOR);
    expect(legacyRow.kind).toBe("anchor");
  });

  it("reaps long-dead INSTANCE rows at register; anchor rows are never reaped", async () => {
    const staleInstance = await db.channelAdapter.create({
      data: {
        token: `cha_${P}stale-instance`,
        name: `${P}stale-instance`,
        kind: "instance",
        lastSeenAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    const staleAnchor = await db.channelAdapter.create({
      data: {
        token: `cha_${P}stale-anchor`,
        name: `${P}stale-anchor`,
        kind: "anchor",
        lastSeenAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
      select: { id: true },
    });

    await adapters.registerAdapter({
      token: ADAPTER_ANCHOR,
      name: `${P}mint-reaper`,
      perInstance: true,
    });
    // The reap is fire-and-forget off the register — observe, don't sleep.
    await vi.waitFor(async () => {
      expect(
        await db.channelAdapter.count({ where: { id: staleInstance.id } }),
      ).toBe(0);
    });
    // An idle self-host coming back after a month keeps its identity.
    expect(
      await db.channelAdapter.count({ where: { id: staleAnchor.id } }),
    ).toBe(1);
  });
});

describe.skipIf(!PROOF_URL)("presence ownership (§3.17)", () => {
  /** Raw owner/lease readback — the columns Prisma writes never touch. */
  const ownersOf = async () => {
    const rows = await db.agentChannel.findMany({
      where: { agent: { identifier: { startsWith: P } } },
      select: { id: true, ownerAdapterId: true, ownerLeaseExpiresAt: true },
      orderBy: { createdAt: "asc" },
    });
    return new Map(rows.map((r) => [r.id, r]));
  };

  it("a single live adapter claims the WHOLE fleet — the self-host singleton, unchanged", async () => {
    const a = await seedChannelAgent("own-all-a");
    const b = await seedChannelAgent("own-all-b");
    const caller = await seedAdapterCaller();

    const cfg = await adapters.getAdapterConfig(caller);
    if (cfg.notModified) throw new Error("unreachable");

    expect(cfg.presences.map((p) => p.presenceId).sort()).toEqual(
      [a.presenceId, b.presenceId].sort(),
    );
    const owners = await ownersOf();
    expect(owners.get(a.presenceId)?.ownerAdapterId).toBe(caller.adapterId);
    expect(owners.get(b.presenceId)?.ownerAdapterId).toBe(caller.adapterId);
  });

  it("claims SKIP locked rows without blocking (the due-work law under real concurrency)", async () => {
    // MUTATION-TESTED two ways: remove `SKIP LOCKED` from the claim CTE and
    // this call blocks on the held row past the race guard; remove the
    // `(owner IS NULL OR lease < now())` arm and live leases get stolen
    // (asserted in the handover test below).
    const p1 = await seedChannelAgent("own-skip-1");
    const p2 = await seedChannelAgent("own-skip-2");
    const caller = await seedAdapterCaller();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let lockTaken!: () => void;
    const taken = new Promise<void>((resolve) => (lockTaken = resolve));
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM agent_channels WHERE id = ${p1.presenceId} FOR UPDATE`;
        lockTaken();
        await gate;
      },
      { timeout: 15_000 },
    );
    // Observe the lock, never guess at it: the claimer starts strictly after
    // the holder's FOR UPDATE resolved.
    await taken;

    const cfg = await Promise.race([
      adapters.getAdapterConfig(caller),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("claim blocked on a locked row")),
          5_000,
        ),
      ),
    ]);
    release();
    await holder;

    if (cfg.notModified) throw new Error("unreachable");
    // The locked row was skipped, not waited for; the free row was claimed.
    expect(cfg.presences.map((p) => p.presenceId)).toEqual([p2.presenceId]);
    const owners = await ownersOf();
    expect(owners.get(p1.presenceId)?.ownerAdapterId).toBeNull();
    expect(owners.get(p2.presenceId)?.ownerAdapterId).toBe(caller.adapterId);
  });

  it("fair-share rebalance: a joiner is fed by voluntary shed within one poll round, then stable", async () => {
    const seeded = [
      await seedChannelAgent("own-fair-1"),
      await seedChannelAgent("own-fair-2"),
      await seedChannelAgent("own-fair-3"),
      await seedChannelAgent("own-fair-4"),
    ];
    const a = await seedAdapterCaller();
    const first = await adapters.getAdapterConfig(a);
    if (first.notModified) throw new Error("unreachable");
    expect(first.presences).toHaveLength(4);

    const b = await seedAdapterCaller();
    // A's next poll sheds down to its fair share (ceil(4/2) = 2)...
    const shedPass = await adapters.getAdapterConfig(a);
    if (shedPass.notModified) throw new Error("unreachable");
    expect(shedPass.presences).toHaveLength(2);
    // ...and B's poll claims exactly the shed rows.
    const claimPass = await adapters.getAdapterConfig(b);
    if (claimPass.notModified) throw new Error("unreachable");
    expect(claimPass.presences).toHaveLength(2);

    const aIds = shedPass.presences.map((p) => p.presenceId);
    const bIds = claimPass.presences.map((p) => p.presenceId);
    expect(aIds.filter((id) => bIds.includes(id))).toEqual([]);
    expect([...aIds, ...bIds].sort()).toEqual(
      seeded.map((s) => s.presenceId).sort(),
    );

    // Stability: another round moves nothing — proven the strong way, as a
    // 304 against each instance's previous etag (a moved slice busts it).
    const aAgain = await adapters.getAdapterConfig(a, shedPass.etag);
    const bAgain = await adapters.getAdapterConfig(b, claimPass.etag);
    expect(aAgain.notModified).toBe(true);
    expect(bAgain.notModified).toBe(true);
  });

  it("a dead peer's slice fails over on the LEASE window, not the 90s online window", async () => {
    // The deploy/death gap this pins: a survivor already AT fair share must
    // still claim a dead peer's expired-lease rows the moment they expire.
    // MUTATION-TESTED: put RUNNER_ONLINE_THRESHOLD_SECONDS back into the
    // `live` count and the corpse (last seen 60s ago — inside 90s, outside
    // the 45s lease window) halves B's fair share, so B claims only 2 of 4
    // here and the fleet strands for another ~40s.
    const seeded = [
      await seedChannelAgent("own-dead-1"),
      await seedChannelAgent("own-dead-2"),
      await seedChannelAgent("own-dead-3"),
      await seedChannelAgent("own-dead-4"),
    ];
    const a = await seedAdapterCaller();
    await adapters.getAdapterConfig(a); // A owns all 4

    await db.$executeRaw`UPDATE agent_channels SET owner_lease_expires_at = now() - interval '1 second' WHERE owner_adapter_id = ${a.adapterId}`;
    await db.$executeRaw`UPDATE channel_adapters SET last_seen_at = now() - interval '60 seconds' WHERE id = ${a.adapterId}`;

    const b = await seedAdapterCaller();
    const cfgB = await adapters.getAdapterConfig(b);
    if (cfgB.notModified) throw new Error("unreachable");
    expect(cfgB.presences.map((p) => p.presenceId).sort()).toEqual(
      seeded.map((s) => s.presenceId).sort(),
    );
  });

  it("EXPIRED leases fail over; live leases are never stolen and renewal never resurrects", async () => {
    const p1 = await seedChannelAgent("own-lease-1");
    const p2 = await seedChannelAgent("own-lease-2");
    const a = await seedAdapterCaller();
    await adapters.getAdapterConfig(a); // A owns both

    // p1's lease lapses (a dead instance); p2 stays live. A itself goes
    // liveness-stale so B's fair share is the whole fleet.
    await db.$executeRaw`UPDATE agent_channels SET owner_lease_expires_at = now() - interval '1 second' WHERE id = ${p1.presenceId}`;
    await db.$executeRaw`UPDATE channel_adapters SET last_seen_at = now() - interval '10 minutes' WHERE id = ${a.adapterId}`;

    const b = await seedAdapterCaller();
    const cfgB = await adapters.getAdapterConfig(b);
    if (cfgB.notModified) throw new Error("unreachable");
    // MUTATION-TESTED: drop the `(owner IS NULL OR lease < now())` claim arm
    // and p2's LIVE lease is stolen here too.
    expect(cfgB.presences.map((p) => p.presenceId)).toEqual([p1.presenceId]);
    expect((await ownersOf()).get(p2.presenceId)?.ownerAdapterId).toBe(
      a.adapterId,
    );

    // A comes back: its renewal is fenced on owner = me, so the stolen p1
    // stays B's — and B's lease clock is untouched by A's pass.
    const before = (await ownersOf()).get(p1.presenceId);
    const cfgA = await adapters.getAdapterConfig(a);
    if (!cfgA.notModified) {
      expect(
        cfgA.presences.map((p) => p.presenceId).includes(p1.presenceId),
      ).toBe(false);
    }
    const after = (await ownersOf()).get(p1.presenceId);
    expect(after?.ownerAdapterId).toBe(b.adapterId);
    expect(after?.ownerLeaseExpiresAt?.getTime()).toBe(
      before?.ownerLeaseExpiresAt?.getTime(),
    );
  });

  it("the work and prompt feeds serve ONLY the caller's slice", async () => {
    // MUTATION-TESTED: drop the `ownerAdapterId` WHERE from getAdapterWork or
    // listUnsettledPrompts and the foreign row leaks into this feed.
    const one = await seedChannelAgent("own-feed-1");
    const two = await seedChannelAgent("own-feed-2");
    const a = await seedAdapterCaller();
    const b = await seedAdapterCaller();
    await db.$executeRaw`UPDATE agent_channels SET owner_adapter_id = ${a.adapterId}, owner_lease_expires_at = now() + interval '45 seconds' WHERE id = ${one.presenceId}`;
    await db.$executeRaw`UPDATE agent_channels SET owner_adapter_id = ${b.adapterId}, owner_lease_expires_at = now() + interval '45 seconds' WHERE id = ${two.presenceId}`;

    const linkFor = async (
      agentId: string,
      presenceId: string,
      ref: string,
    ) => {
      const conversation = await db.conversation.create({
        data: { agentId, source: "slack", externalRef: ref },
        select: { id: true },
      });
      const link = await db.channelThreadLink.create({
        data: {
          agentChannelId: presenceId,
          conversationId: conversation.id,
          externalThreadId: ref,
          kind: "group",
        },
        select: { id: true },
      });
      await db.$executeRaw`UPDATE channel_thread_links SET created_at = now() - interval '10 minutes' WHERE id = ${link.id}`;
      const turn = await db.turn.create({
        data: {
          conversationId: conversation.id,
          message: `answer for ${ref}`,
          status: "done",
          source: "slack",
          userId: MEMBER,
          finishedAt: new Date(),
        },
        select: { id: true },
      });
      return turn.id;
    };
    const turnOne = await linkFor(one.agentId, one.presenceId, "C-own-1:1");
    await linkFor(two.agentId, two.presenceId, "C-own-2:1");

    const workA = await adapters.getAdapterWork(a.adapterId);
    expect(workA.finished.map((w) => w.turn.id)).toEqual([turnOne]);

    await adapters.claimApprovalPrompt({
      approvalId: `${P}own-ap-1`,
      agentChannelId: one.presenceId,
      externalThreadId: "D1",
      expiresAt: null,
    });
    await adapters.claimApprovalPrompt({
      approvalId: `${P}own-ap-2`,
      agentChannelId: two.presenceId,
      externalThreadId: "D2",
      expiresAt: null,
    });
    expect(
      (await adapters.listUnsettledPrompts(a.adapterId)).map(
        (prompt) => prompt.approvalId,
      ),
    ).toEqual([`${P}own-ap-1`]);
  });

  it("lease renewal never busts the etag; a cursor advance busts ANCHOR callers only", async () => {
    // MUTATION-TESTED twice over: (a) rewrite an ownership write as a Prisma
    // update and `updatedAt` — an etag input — bumps on every renewal, so the
    // second call stops answering 304; (b) fold cursors back into the
    // instance-kind hash and the instance 304 below breaks.
    const { agentId, presenceId } = await seedChannelAgent("own-etag");
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C-etag:1" },
      select: { id: true },
    });
    const link = await db.channelThreadLink.create({
      data: {
        agentChannelId: presenceId,
        conversationId: conversation.id,
        externalThreadId: "C-etag:1",
        kind: "group",
      },
      select: { id: true },
    });

    const instance = await seedAdapterCaller("instance");
    const first = await adapters.getAdapterConfig(instance);
    if (first.notModified) throw new Error("unreachable");

    // Renewal round: same slice, same etag — a 304.
    const renewed = await adapters.getAdapterConfig(instance, first.etag);
    expect(renewed.notModified).toBe(true);

    // A mirrored turn advances the cursor: the INSTANCE caller keeps its 304
    // (the floor rides work items instead)...
    const floor = new Date();
    expect(await adapters.advanceMirrorCursor(link.id, null, floor)).toBe(true);
    const afterCursor = await adapters.getAdapterConfig(instance, first.etag);
    expect(afterCursor.notModified).toBe(true);

    // ...and the work feed carries that floor for a mid-history acquirer.
    const turn = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "late answer",
        status: "done",
        source: "slack",
        userId: MEMBER,
        finishedAt: new Date(Date.now() + 1_000),
      },
      select: { id: true },
    });
    await db.$executeRaw`UPDATE turns SET created_at = now() + interval '2 seconds' WHERE id = ${turn.id}`;
    const work = await adapters.getAdapterWork(instance.adapterId);
    const item = work.finished.find((w) => w.linkId === link.id);
    // Pinned to the EXACT stored cursor: this field seeds the client's CAS
    // expectation, so any other value (link.createdAt, now()) would CAS-fail
    // forever — a permanent non-delivery invisible to a type-only assertion.
    expect(item?.linkMirrorCursor?.getTime()).toBe(floor.getTime());
  });

  it("the decrypt cache absorbs an etag bust — no second KMS-shaped decrypt of an unchanged credential", async () => {
    // MUTATION-TESTED: bypass the cache (call getCrypto().decrypt directly in
    // the feed) and the second full payload below decrypts again.
    const caller = await seedAdapterCaller();
    await seedChannelAgent("own-cache-a", {
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-cache" }),
      ),
    });
    const first = await adapters.getAdapterConfig(caller);
    if (first.notModified) throw new Error("unreachable");

    // A new (credential-less) presence busts the etag; the cached ciphertext
    // must not be decrypted again.
    await seedChannelAgent("own-cache-b");
    const decryptSpy = vi.spyOn(getCrypto(), "decrypt");
    try {
      const second = await adapters.getAdapterConfig(caller, first.etag);
      expect(second.notModified).toBe(false);
      if (second.notModified) throw new Error("unreachable");
      expect(
        second.presences.find((p) => p.credentialsJson !== null)
          ?.credentialsJson,
      ).toBe(JSON.stringify({ botToken: "xoxb-cache" }));
      expect(decryptSpy).not.toHaveBeenCalled();
    } finally {
      decryptSpy.mockRestore();
    }
  });
});

describe.skipIf(!PROOF_URL)("getAdapterConfig", () => {
  it("serves active AND needs_attention presences with decrypted credentials; the etag tracks link cursors", async () => {
    const { agentId, integrationId, presenceId } = await seedChannelAgent(
      "cfg-a",
      {
        presenceCredentials: await getCrypto().encrypt(
          JSON.stringify({ botToken: "xoxb-cfg" }),
        ),
      },
    );
    const serviceKey = await db.apiKey.create({
      data: {
        key: `oc_${P}cfg-service-key`,
        userId: ADMIN,
        userEmail: `${ADMIN}@example.com`,
        workspaceId: WORKSPACE,
        scope: "workspace",
        kind: "service",
      },
      select: { id: true, key: true },
    });
    await db.agentChannel.update({
      where: { id: presenceId },
      data: { apiKeyId: serviceKey.id },
    });

    // A needs_attention sibling (kept live: only its approvals are broken)...
    const attentionAgent = await seedAgent("cfg-b");
    const attention = await seedPresence(attentionAgent, integrationId, {
      status: "needs_attention",
      externalId: "A-cfg-b",
    });
    // ...and two that must NOT appear.
    const pendingAgent = await seedAgent("cfg-c");
    await seedPresence(pendingAgent, integrationId, {
      status: "pending_setup",
      externalId: "A-cfg-c",
    });
    const disabledAgent = await seedAgent("cfg-d");
    await seedPresence(disabledAgent, integrationId, {
      status: "disabled",
      externalId: "A-cfg-d",
    });

    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C9:1.1" },
      select: { id: true },
    });
    const link = await db.channelThreadLink.create({
      data: {
        agentChannelId: presenceId,
        conversationId: conversation.id,
        externalThreadId: "C9:1.1",
        kind: "group",
      },
      select: { id: true },
    });

    const caller = await seedAdapterCaller();
    const config = await adapters.getAdapterConfig(caller);
    if (config.notModified) throw new Error("unreachable");

    expect(config.presences.map((p) => p.presenceId)).toEqual([
      presenceId,
      attention.id,
    ]);
    const [main] = config.presences;
    expect(main?.credentialsJson).toBe(
      JSON.stringify({ botToken: "xoxb-cfg" }),
    );
    expect(main?.approvalsKey).toBe(serviceKey.key);
    expect(main?.tenant.externalId).toBe("T111");
    expect(main?.links.map((l) => l.id)).toEqual([link.id]);

    // The etag is the adapter's "did anything change" check: a moved mirror
    // cursor must change it, or the adapter never refetches the link state.
    const etagBefore = config.etag;
    expect(await adapters.advanceMirrorCursor(link.id, null, new Date())).toBe(
      true,
    );
    const after = await adapters.getAdapterConfig(caller);
    if (after.notModified) throw new Error("unreachable");
    expect(after.etag).not.toBe(etagBefore);
  });

  it("carries the avatar only from a PUBLIC origin, and the imageKey busts the etag", async () => {
    const { agentId } = await seedChannelAgent("cfg-img");
    const keyA = "a".repeat(32);
    const keyB = "b".repeat(32);
    await db.agent.update({
      where: { id: agentId },
      data: { imageKey: keyA },
    });

    // Socket posture (the beforeEach default, localhost origin): Slack could
    // never fetch the icon, so the feed must not carry it at all.
    const caller = await seedAdapterCaller();
    const socketCfg = await adapters.getAdapterConfig(caller);
    if (socketCfg.notModified) throw new Error("unreachable");
    expect(socketCfg.presences[0]?.agent.imageUrl).toBeNull();

    // Public HTTPS posture: the key-fenced URL rides the feed — and the
    // posture flip itself busts the etag (it is a feed input; a long-running
    // adapter must not keep getting 304s across an API_URL change).
    initSelfUrl(EVENTS_SELF_URL);
    const cfg = await adapters.getAdapterConfig(caller);
    if (cfg.notModified) throw new Error("unreachable");
    expect(cfg.etag).not.toBe(socketCfg.etag);
    expect(cfg.presences[0]?.agent.imageUrl).toBe(
      `${EVENTS_SELF_URL}/v1/agent-images/${agentId}/${keyA}`,
    );

    // MUTATION-TESTED (the etag's imageKey input): a rotated key must bust
    // the etag — the adapter's only refetch signal — or it serves the old
    // icon until some unrelated change; a cleared key must bust it again.
    const etagBefore = cfg.etag;
    await db.agent.update({
      where: { id: agentId },
      data: { imageKey: keyB },
    });
    const rotated = await adapters.getAdapterConfig(caller);
    if (rotated.notModified) throw new Error("unreachable");
    expect(rotated.etag).not.toBe(etagBefore);
    expect(rotated.presences[0]?.agent.imageUrl).toContain(keyB);

    await db.agent.update({
      where: { id: agentId },
      data: { imageKey: null },
    });
    const cleared = await adapters.getAdapterConfig(caller);
    if (cleared.notModified) throw new Error("unreachable");
    expect(cleared.etag).not.toBe(rotated.etag);
    expect(cleared.presences[0]?.agent.imageUrl).toBeNull();
  });

  it("a matching If-None-Match returns notModified:true WITHOUT decrypting", async () => {
    // MUTATION-TESTED (the early 304 return): the etag is computed from the
    // plain rows, so a matching If-None-Match must short-circuit BEFORE the
    // per-credential KMS decrypt. Delete the early return and the call decrypts
    // the whole fleet on every idle poll — observable here as a decrypt call
    // and a `presences` array where there should be none.
    await seedChannelAgent("cfg-304", {
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-304" }),
      ),
    });
    const caller = await seedAdapterCaller();
    const seed = await adapters.getAdapterConfig(caller);
    if (seed.notModified) throw new Error("unreachable");
    // The decrypt CACHE would also absorb the mutated-away early return —
    // clear it so the spy below stays a real signal.
    decryptCache.resetDecryptCacheForTests();

    const decryptSpy = vi.spyOn(getCrypto(), "decrypt");
    try {
      const cached = await adapters.getAdapterConfig(caller, seed.etag);
      expect(cached.notModified).toBe(true);
      expect(cached).not.toHaveProperty("presences");
      expect(decryptSpy).not.toHaveBeenCalled();
    } finally {
      decryptSpy.mockRestore();
    }
  });
});

describe.skipIf(!PROOF_URL)("advanceMirrorCursor (CAS)", () => {
  it("only the matching expectation writes; the loser writes NOTHING", async () => {
    const { agentId, presenceId } = await seedChannelAgent("cas");
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C1:1.1" },
      select: { id: true },
    });
    const link = await db.channelThreadLink.create({
      data: {
        agentChannelId: presenceId,
        conversationId: conversation.id,
        externalThreadId: "C1:1.1",
        kind: "group",
      },
      select: { id: true },
    });
    const t1 = new Date("2026-08-06T10:00:00.000Z");
    const t2 = new Date("2026-08-06T11:00:00.000Z");

    expect(await adapters.advanceMirrorCursor(link.id, null, t1)).toBe(true);

    // MUTATION-TESTED: the CAS is the WHERE on mirrorCursor — drop `expect`
    // from the where and a stale adapter twin re-claims work the winner
    // already posted (double-posted answers). The stale claim must both
    // return false AND leave the cursor untouched.
    expect(await adapters.advanceMirrorCursor(link.id, null, t2)).toBe(false);
    const row = await db.channelThreadLink.findUniqueOrThrow({
      where: { id: link.id },
      select: { mirrorCursor: true },
    });
    expect(row.mirrorCursor).toEqual(t1);

    expect(await adapters.advanceMirrorCursor(link.id, t1, t2)).toBe(true);
  });

  it("requires STRICT progress: equal or earlier `next` writes nothing", async () => {
    // MUTATION-TESTED (the `next <= expect` guard): a stale work snapshot whose
    // turn a twin already advanced the cursor past would otherwise "win"
    // trivially (expect === next matches the CAS) and re-post an answer already
    // on the thread. Delete the guard and the equal-cursor claim returns true.
    const { agentId, presenceId } = await seedChannelAgent("cas-strict");
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C2:1.1" },
      select: { id: true },
    });
    const link = await db.channelThreadLink.create({
      data: {
        agentChannelId: presenceId,
        conversationId: conversation.id,
        externalThreadId: "C2:1.1",
        kind: "group",
      },
      select: { id: true },
    });
    const t0 = new Date("2026-08-06T09:00:00.000Z");
    const t1 = new Date("2026-08-06T10:00:00.000Z");
    const t2 = new Date("2026-08-06T11:00:00.000Z");

    expect(await adapters.advanceMirrorCursor(link.id, null, t1)).toBe(true);

    const cursorNow = async () =>
      (
        await db.channelThreadLink.findUniqueOrThrow({
          where: { id: link.id },
          select: { mirrorCursor: true },
        })
      ).mirrorCursor;

    // Equal: no progress → false, cursor untouched.
    expect(await adapters.advanceMirrorCursor(link.id, t1, t1)).toBe(false);
    expect(await cursorNow()).toEqual(t1);

    // Earlier: backwards → false, cursor untouched.
    expect(await adapters.advanceMirrorCursor(link.id, t1, t0)).toBe(false);
    expect(await cursorNow()).toEqual(t1);

    // Strictly later: the only case that advances.
    expect(await adapters.advanceMirrorCursor(link.id, t1, t2)).toBe(true);
    expect(await cursorNow()).toEqual(t2);
  });
});

describe.skipIf(!PROOF_URL)("getAdapterWork", () => {
  const seedLinkedConversation = async (suffix: string) => {
    const { agentId, presenceId, integrationId } =
      await seedChannelAgent(suffix);
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: `C-${suffix}:1.1` },
      select: { id: true },
    });
    const link = await db.channelThreadLink.create({
      data: {
        agentChannelId: presenceId,
        conversationId: conversation.id,
        externalThreadId: `C-${suffix}:1.1`,
        kind: "group",
      },
      select: { id: true, createdAt: true },
    });
    return { agentId, presenceId, integrationId, conversation, link };
  };

  it("surfaces only FINISHED turns past the cursor — running turns wait; the cursor floors replay", async () => {
    const { conversation, link, presenceId } =
      await seedLinkedConversation("work");
    // Backdate the link so every turn below is unambiguously AFTER it.
    await db.$executeRaw`UPDATE channel_thread_links SET created_at = now() - interval '10 minutes' WHERE id = ${link.id}`;

    const turn = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "still running",
        status: "running",
        source: "slack",
        userId: MEMBER,
      },
      select: { id: true },
    });

    // Running: NOT work — there is no live rendering; the completion pass
    // waits for the turn to land.
    const caller = await seedClaimedCaller();
    let work = await adapters.getAdapterWork(caller.adapterId);
    expect(work.finished).toEqual([]);

    // Finished: exactly one work item, addressed through its link.
    await db.turn.update({
      where: { id: turn.id },
      data: { status: "done", finishedAt: new Date() },
    });
    work = await adapters.getAdapterWork(caller.adapterId);
    expect(work.finished.map((w) => w.turn.id)).toEqual([turn.id]);
    expect(work.finished[0]).toMatchObject({
      linkId: link.id,
      presenceId,
      conversationId: conversation.id,
    });

    // Advance the cursor to the turn's createdAt: posted exactly once.
    const row = await db.turn.findUniqueOrThrow({
      where: { id: turn.id },
      select: { createdAt: true },
    });
    expect(
      await adapters.advanceMirrorCursor(link.id, null, row.createdAt),
    ).toBe(true);
    work = await adapters.getAdapterWork(caller.adapterId);
    expect(work.finished).toEqual([]);
  });

  it("NEVER mirrors turns older than the link itself (the createdAt floor)", async () => {
    // MUTATION-TESTED: the floor is `createdAt: { gt: l.mirrorCursor ??
    // l.createdAt }` — replace the fallback with an epoch (or drop the
    // filter) and a link created mid-history replays the ENTIRE past
    // conversation into the provider on first poll. The planted pre-link
    // turn below is what such a mutation would surface.
    const { conversation, link } = await seedLinkedConversation("floor");
    const old = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "ancient history",
        status: "done",
        source: "web",
        userId: MEMBER,
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    // The turn PREDATES the link.
    await db.$executeRaw`UPDATE turns SET created_at = now() - interval '1 hour' WHERE id = ${old.id}`;

    const caller = await seedClaimedCaller();
    const work = await adapters.getAdapterWork(caller.adapterId);
    expect(work.finished).toEqual([]);

    // A turn born AFTER the link mirrors normally.
    const fresh = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "new answer",
        status: "done",
        source: "slack",
        userId: MEMBER,
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    await db.$executeRaw`UPDATE channel_thread_links SET created_at = now() - interval '10 minutes' WHERE id = ${link.id}`;
    const later = await adapters.getAdapterWork(caller.adapterId);
    expect(later.finished.map((w) => w.turn.id)).toEqual([fresh.id]);
  });

  it("a PROMOTED follow-up mirrors at its promotion time — the cursor cannot skip it", async () => {
    // MUTATION-PROOF for the promotion-aware floor: a promoted follow-up
    // keeps its birth createdAt, which the cursor may already have passed
    // (a later-created turn finished while it sat parked). Floored on bare
    // createdAt, its answer would NEVER post to Slack; the mirror timeline
    // therefore reads COALESCE(promoted_at, created_at).
    const { conversation, link } = await seedLinkedConversation("promoted");
    // The cursor already sits at "now" (a later-created turn mirrored).
    await db.channelThreadLink.update({
      where: { id: link.id },
      data: { mirrorCursor: new Date() },
    });
    // A follow-up born BEFORE the cursor, promoted and finished AFTER it.
    const followUp = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "parked while others finished",
        status: "done",
        source: "slack",
        userId: MEMBER,
        followUpOfTurnId: "some-closed-turn",
        promotedAt: new Date(Date.now() + 1_000),
        finishedAt: new Date(Date.now() + 2_000),
      },
      select: { id: true },
    });
    await db.$executeRaw`UPDATE turns SET created_at = now() - interval '30 minutes' WHERE id = ${followUp.id}`;

    const caller = await seedClaimedCaller();
    const work = await adapters.getAdapterWork(caller.adapterId);

    const item = work.finished.find((w) => w.turn.id === followUp.id);
    expect(item).toBeDefined();
    // The wire watermark is the promotion stamp, so the CAS still advances.
    expect(item?.turn.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("resolves attribution names PER AUTHOR — the asker and each follow-up's own speaker", async () => {
    // On a group thread a follow-up's author can differ from the turn's
    // asker, so each follow-up carries its OWN userName on the wire.
    // MUTATION-TESTED: drop `userId` from the follow-up select (or reuse the
    // turn's name in the mapping) and the ADMIN follow-up below surfaces as
    // null / under Morgan's name — the exact misattribution this pins.
    const { conversation, link } = await seedLinkedConversation("names");
    // Backdate the link so the turns below are unambiguously AFTER it (the
    // mirror floor is strict).
    await db.$executeRaw`UPDATE channel_thread_links SET created_at = now() - interval '10 minutes' WHERE id = ${link.id}`;
    const asked = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "who is on call?",
        status: "done",
        source: "web",
        userId: MEMBER,
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "and check the pager",
        status: "joined",
        source: "web",
        userId: ADMIN,
        followUpOfTurnId: asked.id,
      },
    });

    const caller = await seedClaimedCaller();
    const work = await adapters.getAdapterWork(caller.adapterId);

    const item = work.finished.find((w) => w.turn.id === asked.id);
    expect(item?.turn.userName).toBe("Morgan Member");
    // ADMIN has no display name → unnamed, NEVER the email local-part: the
    // Slack audience is not fenced to workspace membership, so email-derived
    // identity must not travel there.
    expect(item?.followUps.map((f) => f.userName)).toEqual([null]);
    expect(JSON.stringify(item)).not.toContain(`${ADMIN}@example.com`);
  });
});

describe.skipIf(!PROOF_URL)("turn receipts (the reaction 'seen' mark)", () => {
  it("attach writes the ledger row and marks the message; clear unmarks and deletes", async () => {
    const { presenceId } = await seedChannelAgent("receipt-basic", {
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-receipt" }),
      ),
    });
    slackHandlers["reactions.add"] = () => ({ ok: true });
    slackHandlers["reactions.remove"] = () => ({ ok: true });

    await receipts.attachTurnReceipt({
      presenceId,
      turnId: "turn-receipt-1",
      channel: "D900",
      messageTs: "500.0001",
      text: "hey there",
    });

    // No LLM grant is seeded → the chooser falls back to "eyes" WITHOUT a
    // model call (fail-closed key resolution), so the pick is deterministic.
    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: "turn-receipt-1" },
    });
    expect(row.reaction).toBe("eyes");
    expect(row.channel).toBe("D900");
    const add = slackCallsFor("reactions.add").at(-1)!;
    expect(add.token).toBe("xoxb-receipt");
    expect(add.form.get("channel")).toBe("D900");
    expect(add.form.get("timestamp")).toBe("500.0001");
    expect(add.form.get("name")).toBe("eyes");

    await receipts.clearTurnReceipt("turn-receipt-1");
    const remove = slackCallsFor("reactions.remove").at(-1)!;
    expect(remove.form.get("channel")).toBe("D900");
    expect(remove.form.get("timestamp")).toBe("500.0001");
    expect(remove.form.get("name")).toBe("eyes");
    expect(
      await db.channelTurnReceipt.findUnique({
        where: { turnId: "turn-receipt-1" },
      }),
    ).toBeNull();
  });

  it("clearing an unknown turn is a silent no-op (web turns never had a receipt)", async () => {
    const before = slackCallsFor("reactions.remove").length;
    await receipts.clearTurnReceipt("turn-that-never-was");
    expect(slackCallsFor("reactions.remove")).toHaveLength(before);
  });

  it("agent-flavor presence in a thread: the session loader IS the ack, and the clear sets it back", async () => {
    const { presenceId } = await seedChannelAgent("receipt-session", {
      appMode: "agent",
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-session" }),
      ),
    });
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });
    const addsBefore = slackCallsFor("reactions.add").length;

    await receipts.attachTurnReceipt({
      presenceId,
      turnId: "turn-session-1",
      channel: "C900",
      messageTs: "600.0002",
      threadTs: "600.0001",
      text: "do the thing",
    });

    // The mark is the native loader: a session row keyed by the THREAD ROOT
    // (the address the clear needs), no emoji, and NO reactions.add call.
    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: "turn-session-1" },
    });
    expect(row.kind).toBe("session");
    expect(row.reaction).toBeNull();
    expect(row.messageTs).toBe("600.0001");
    expect(slackCallsFor("reactions.add")).toHaveLength(addsBefore);
    const set = slackCallsFor("agents.sessions.setStatus").at(-1)!;
    expect(set.token).toBe("xoxb-session");
    expect(set.form.get("channel_id")).toBe("C900");
    expect(set.form.get("thread_ts")).toBe("600.0001");
    expect(set.form.get("status")).toBe("processing");

    // The clear must set "active" EXPLICITLY — Slack never auto-clears the
    // sessions loader on a message post.
    await receipts.clearTurnReceipt("turn-session-1");
    const cleared = slackCallsFor("agents.sessions.setStatus").at(-1)!;
    expect(cleared.form.get("status")).toBe("active");
    expect(cleared.form.get("thread_ts")).toBe("600.0001");
    expect(
      await db.channelTurnReceipt.findUnique({
        where: { turnId: "turn-session-1" },
      }),
    ).toBeNull();
  });

  it("falls back to the reaction when the loader is refused (plan-gated workspace) — the ack never vanishes", async () => {
    const { presenceId } = await seedChannelAgent("receipt-fallback", {
      appMode: "agent",
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-fallback" }),
      ),
    });
    // A free workspace: the sessions API answers feature_disabled.
    slackHandlers["agents.sessions.setStatus"] = () => ({
      ok: false,
      error: "feature_disabled",
    });
    slackHandlers["reactions.add"] = () => ({ ok: true });

    await receipts.attachTurnReceipt({
      presenceId,
      turnId: "turn-fallback-1",
      channel: "C901",
      messageTs: "601.0002",
      threadTs: "601.0001",
      text: "hello",
    });

    // MUTATION-TESTED: drop the fallback and this row (and the user's only
    // ack) never exists.
    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: "turn-fallback-1" },
    });
    expect(row.kind).toBe("reaction");
    expect(row.reaction).toBe("eyes");
    expect(row.messageTs).toBe("601.0002");
    const add = slackCallsFor("reactions.add").at(-1)!;
    expect(add.form.get("channel")).toBe("C901");
    expect(add.form.get("timestamp")).toBe("601.0002");
  });

  it("agent-flavor DM (no thread): the reaction, exactly as before — DMs answer top-level and never get the loader", async () => {
    const { presenceId } = await seedChannelAgent("receipt-agent-dm", {
      appMode: "agent",
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-agent-dm" }),
      ),
    });
    slackHandlers["reactions.add"] = () => ({ ok: true });
    const statusBefore = slackCallsFor("agents.sessions.setStatus").length;

    await receipts.attachTurnReceipt({
      presenceId,
      turnId: "turn-agent-dm-1",
      channel: "D901",
      messageTs: "602.0001",
      text: "hi",
    });

    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: "turn-agent-dm-1" },
    });
    expect(row.kind).toBe("reaction");
    expect(slackCallsFor("agents.sessions.setStatus")).toHaveLength(
      statusBefore,
    );
  });

  it("a follow-up under a session mark LEAVES the row on the running turn — the loader already covers the thread", async () => {
    // The session receipt belongs to the RUN, not to the last message that
    // joined it. Two things depend on it staying put:
    //   - the narration card is keyed by turn id, and the supervisor reports
    //     tool activity under the turn it is running (a steer never moves
    //     `activeTurnId`), so moving the row hides the card — see the
    //     regression pair in "turn narration" below;
    //   - the clear walks the finished turn AND its joined follow-ups, so it
    //     finds the row here without any re-key.
    const { agentId, presenceId } = await seedChannelAgent(
      "receipt-session-move",
      {
        appMode: "agent",
        presenceCredentials: await getCrypto().encrypt(
          JSON.stringify({ botToken: "xoxb-session-move" }),
        ),
      },
    );
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C902:700.0001" },
      select: { id: true },
    });
    const target = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "start",
        status: "running",
        source: "slack",
      },
      select: { id: true },
    });
    const followUp = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "and also",
        status: "joined",
        source: "slack",
        followUpOfTurnId: target.id,
      },
      select: { id: true },
    });
    await receipts.attachTurnReceipt({
      presenceId,
      turnId: target.id,
      channel: "C902",
      messageTs: "700.0002",
      threadTs: "700.0001",
      text: "start",
    });
    const statusCalls = slackCallsFor("agents.sessions.setStatus").length;
    const addsBefore = slackCallsFor("reactions.add").length;

    await receipts.moveTurnReceipt({
      presenceId,
      followUpTurnId: followUp.id,
      conversationId: conversation.id,
      channel: "C902",
      messageTs: "700.0003",
      threadTs: "700.0001",
      text: "and also",
    });

    // No provider traffic — the loader on the thread already covers the
    // follow-up.
    expect(slackCallsFor("agents.sessions.setStatus")).toHaveLength(
      statusCalls,
    );
    expect(slackCallsFor("reactions.add")).toHaveLength(addsBefore);
    // The row did NOT move: it is still the running turn's.
    // MUTATION-PROOF: re-key it to the follow-up and this fails.
    const stayed = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: target.id },
    });
    expect(stayed.kind).toBe("session");
    expect(stayed.messageTs).toBe("700.0001");
    expect(
      await db.channelTurnReceipt.findUnique({
        where: { turnId: followUp.id },
      }),
    ).toBeNull();
  });

  it("the clear still finds a session row that stayed on the running turn", async () => {
    // The other half of the contract above: not re-keying is only safe
    // because `clearTurnReceipts` resolves the family. Proven, not assumed —
    // the answer posts against the FINISHED turn's id while the row sits on
    // that same turn, with a joined follow-up beside it.
    const { agentId, presenceId } = await seedChannelAgent(
      "receipt-session-stay-clear",
      {
        appMode: "agent",
        presenceCredentials: await getCrypto().encrypt(
          JSON.stringify({ botToken: "xoxb-session-stay" }),
        ),
      },
    );
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C903:701.0001" },
      select: { id: true },
    });
    const target = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "start",
        status: "running",
        source: "slack",
      },
      select: { id: true },
    });
    const followUp = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "and also",
        status: "joined",
        source: "slack",
        followUpOfTurnId: target.id,
      },
      select: { id: true },
    });
    await receipts.attachTurnReceipt({
      presenceId,
      turnId: target.id,
      channel: "C903",
      messageTs: "701.0002",
      threadTs: "701.0001",
      text: "start",
    });
    await receipts.moveTurnReceipt({
      presenceId,
      followUpTurnId: followUp.id,
      conversationId: conversation.id,
      channel: "C903",
      messageTs: "701.0003",
      threadTs: "701.0001",
      text: "and also",
    });
    // The turn finishes and the answer posts.
    await db.turn.update({
      where: { id: target.id },
      data: { status: "done", finishedAt: new Date() },
    });

    await receipts.clearTurnReceipts(target.id);

    // The loader came down and the ledger is empty — no leak.
    const cleared = slackCallsFor("agents.sessions.setStatus").at(-1)!;
    expect(cleared.form.get("status")).toBe("active");
    expect(cleared.form.get("thread_ts")).toBe("701.0001");
    expect(
      await db.channelTurnReceipt.findUnique({ where: { turnId: target.id } }),
    ).toBeNull();
  });

  it("a PROMOTED follow-up leaves the session mark clearable by the turn that owns it", async () => {
    // The edge the old re-key handled worst. A follow-up that is promoted
    // becomes `queued`, not `joined` — and `clearTurnReceipts` walks the
    // finished turn plus its JOINED follow-ups. Under the re-key the row had
    // moved onto that promoted turn, so the clear missed it and the loader
    // burned until the 10-minute stale sweep caught it.
    //
    // With the row left where it was attached, the clear finds it directly.
    const { agentId, presenceId } = await seedChannelAgent(
      "receipt-session-promoted",
      {
        appMode: "agent",
        presenceCredentials: await getCrypto().encrypt(
          JSON.stringify({ botToken: "xoxb-session-promoted" }),
        ),
      },
    );
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C904:702.0001" },
      select: { id: true },
    });
    const target = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "start",
        status: "running",
        source: "slack",
      },
      select: { id: true },
    });
    const followUp = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "and also",
        status: "joining",
        source: "slack",
        followUpOfTurnId: target.id,
      },
      select: { id: true },
    });
    await receipts.attachTurnReceipt({
      presenceId,
      turnId: target.id,
      channel: "C904",
      messageTs: "702.0002",
      threadTs: "702.0001",
      text: "start",
    });
    await receipts.moveTurnReceipt({
      presenceId,
      followUpTurnId: followUp.id,
      conversationId: conversation.id,
      channel: "C904",
      messageTs: "702.0003",
      threadTs: "702.0001",
      text: "and also",
    });
    // The target closes first, then the unconsumed follow-up PROMOTES to its
    // own queued turn (that order is forced: a partial unique index allows
    // only one active turn per conversation, which is exactly why promotion
    // happens at the target's close).
    await db.turn.update({
      where: { id: target.id },
      data: { status: "done", finishedAt: new Date() },
    });
    await db.turn.update({
      where: { id: followUp.id },
      data: { status: "queued", promotedAt: new Date() },
    });

    await receipts.clearTurnReceipts(target.id);

    // The loader came down on the answer post — not minutes later via the
    // stale sweep.
    const cleared = slackCallsFor("agents.sessions.setStatus").at(-1)!;
    expect(cleared.form.get("status")).toBe("active");
    expect(
      await db.channelTurnReceipt.findUnique({ where: { turnId: target.id } }),
    ).toBeNull();
    expect(
      await db.channelTurnReceipt.findUnique({
        where: { turnId: followUp.id },
      }),
    ).toBeNull();
  });

  it("REGRESSION (dev 2026-08-30): a clear that beats the attach no-ops, and the attach self-clears — no stuck loader", async () => {
    const { agentId, presenceId } = await seedChannelAgent("receipt-race", {
      appMode: "agent",
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-race" }),
      ),
    });
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C903:800.0001" },
      select: { id: true },
    });
    // The turn is ALREADY DONE — the fast answer's cursor advance fired its
    // clear before the detached attach's Slack round-trip completed. That
    // clear found no ledger row and no-oped (asserted by the call count).
    const turn = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "what time is it",
        status: "done",
        source: "slack",
      },
      select: { id: true },
    });
    const statusBefore = slackCallsFor("agents.sessions.setStatus").length;
    await receipts.clearTurnReceipts(turn.id);
    expect(slackCallsFor("agents.sessions.setStatus")).toHaveLength(
      statusBefore,
    );

    // The late attach: loader goes on ("processing"), then the terminal
    // recheck sees the finished turn and immediately clears ("active").
    // MUTATION-TESTED: drop `selfClearIfTurnFinished` from the attach and
    // the last call stays "processing" with the row still in the ledger —
    // the exact live incident (loader burning under a posted answer).
    await receipts.attachTurnReceipt({
      presenceId,
      turnId: turn.id,
      channel: "C903",
      messageTs: "800.0002",
      threadTs: "800.0001",
      text: "what time is it",
    });

    const calls = slackCallsFor("agents.sessions.setStatus");
    expect(calls.at(-2)!.form.get("status")).toBe("processing");
    expect(calls.at(-1)!.form.get("status")).toBe("active");
    expect(calls.at(-1)!.form.get("thread_ts")).toBe("800.0001");
    expect(
      await db.channelTurnReceipt.findUnique({ where: { turnId: turn.id } }),
    ).toBeNull();
  });

  it("the recheck leaves a LIVE turn's mark alone — the normal path is untouched", async () => {
    const { agentId, presenceId } = await seedChannelAgent("receipt-live", {
      appMode: "agent",
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-live" }),
      ),
    });
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C904:801.0001" },
      select: { id: true },
    });
    const turn = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "long task",
        status: "running",
        source: "slack",
      },
      select: { id: true },
    });

    await receipts.attachTurnReceipt({
      presenceId,
      turnId: turn.id,
      channel: "C904",
      messageTs: "801.0002",
      threadTs: "801.0001",
      text: "long task",
    });

    // Still working: the loader stays on and the row stays.
    const calls = slackCallsFor("agents.sessions.setStatus");
    expect(calls.at(-1)!.form.get("status")).toBe("processing");
    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: turn.id },
    });
    expect(row.kind).toBe("session");
  });

  it("the stale-session sweep clears only OLD session loaders — young sessions and reaction rows stay", async () => {
    const { agentId, presenceId } = await seedChannelAgent("receipt-sweep", {
      appMode: "agent",
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-sweep" }),
      ),
    });
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });
    slackHandlers["reactions.remove"] = () => ({ ok: true });
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C905:802.0001" },
      select: { id: true },
    });
    const mkTurn = async (message: string) =>
      (
        await db.turn.create({
          data: {
            conversationId: conversation.id,
            message,
            // Terminal on purpose, twice over: the one-active-turn unique
            // allows a single live turn per conversation, and the sweep is
            // age-gated, not status-gated — a leaked loader's turn is done.
            status: "done",
            source: "slack",
          },
          select: { id: true },
        })
      ).id;
    const oldSession = await mkTurn("old session");
    const youngSession = await mkTurn("young session");
    const oldReaction = await mkTurn("old reaction");
    const before = new Date(Date.now() - 11 * 60 * 1000);
    await db.channelTurnReceipt.createMany({
      data: [
        {
          turnId: oldSession,
          agentChannelId: presenceId,
          channel: "C905",
          messageTs: "802.0001",
          kind: "session",
          workStatusSet: true,
          createdAt: before,
        },
        {
          turnId: youngSession,
          agentChannelId: presenceId,
          channel: "C905",
          messageTs: "802.0002",
          kind: "session",
          workStatusSet: true,
        },
        {
          turnId: oldReaction,
          agentChannelId: presenceId,
          channel: "C905",
          messageTs: "802.0003",
          kind: "reaction",
          reaction: "eyes",
          createdAt: before,
        },
      ],
    });

    await receipts.sweepStaleSessionReceipts();

    // MUTATION-TESTED (the age gate): drop the createdAt filter and the
    // young session's loader is yanked mid-run.
    expect(
      await db.channelTurnReceipt.findUnique({ where: { turnId: oldSession } }),
    ).toBeNull();
    const cleared = slackCallsFor("agents.sessions.setStatus").at(-1)!;
    expect(cleared.form.get("status")).toBe("active");
    expect(cleared.form.get("thread_ts")).toBe("802.0001");
    expect(
      await db.channelTurnReceipt.findUnique({
        where: { turnId: youngSession },
      }),
    ).not.toBeNull();
    // Reaction rows are the 24h prune's business, not the sweep's.
    expect(
      await db.channelTurnReceipt.findUnique({
        where: { turnId: oldReaction },
      }),
    ).not.toBeNull();
  });

  /** A conversation with a done target turn and a joining follow-up — the
   * receipt move's real substrate (candidates resolve by conversation). */
  const seedMoveFamily = async (agentId: string, ref: string) => {
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: ref },
      select: { id: true },
    });
    const target = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "the first message",
        status: "running",
        source: "slack",
      },
      select: { id: true },
    });
    const followUp = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "the follow-up",
        status: "joining",
        followUpOfTurnId: target.id,
        source: "slack",
      },
      select: { id: true },
    });
    return { conversationId: conversation.id, target, followUp };
  };

  it("MOVES the mark to a mid-run follow-up: same emoji, new message, old one unmarked", async () => {
    const { agentId, presenceId } = await seedChannelAgent("receipt-move", {
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-move" }),
      ),
    });
    slackHandlers["reactions.add"] = () => ({ ok: true });
    slackHandlers["reactions.remove"] = () => ({ ok: true });
    const { conversationId, target, followUp } = await seedMoveFamily(
      agentId,
      "D901",
    );
    await receipts.attachTurnReceipt({
      presenceId,
      turnId: target.id,
      channel: "D901",
      messageTs: "600.0001",
      text: "the first message",
    });
    const addsBefore = slackCallsFor("reactions.add").length;

    await receipts.moveTurnReceipt({
      presenceId,
      followUpTurnId: followUp.id,
      conversationId,
      channel: "D901",
      messageTs: "600.0002",
      text: "the follow-up",
    });

    // The mark travelled: same reaction (no second chooser inference), new
    // owner row, new message marked, old message unmarked, old row gone.
    const moved = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: followUp.id },
    });
    expect(moved.reaction).toBe("eyes");
    expect(moved.messageTs).toBe("600.0002");
    expect(
      await db.channelTurnReceipt.findUnique({
        where: { turnId: target.id },
      }),
    ).toBeNull();
    const add = slackCallsFor("reactions.add").at(-1)!;
    expect(add.form.get("timestamp")).toBe("600.0002");
    expect(add.form.get("name")).toBe("eyes");
    expect(slackCallsFor("reactions.add")).toHaveLength(addsBefore + 1);
    const remove = slackCallsFor("reactions.remove").at(-1)!;
    expect(remove.form.get("timestamp")).toBe("600.0001");
  });

  it("the move survives a PROMOTION CHAIN — the mark can sit generations away from the direct target", async () => {
    // t1's follow-up f1 carried the mark, got promoted, and the new message
    // targets f1 — a one-level sibling walk would miss the mark and attach a
    // second one. Conversation-wide resolution finds it wherever it sits.
    const { agentId, presenceId } = await seedChannelAgent("receipt-chain", {
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-chain" }),
      ),
    });
    slackHandlers["reactions.add"] = () => ({ ok: true });
    slackHandlers["reactions.remove"] = () => ({ ok: true });
    const {
      conversationId,
      target: t1,
      followUp: f1,
    } = await seedMoveFamily(agentId, "D905");
    // t1 closed; f1 was promoted and now runs; the mark sits on ITS message.
    await db.turn.update({
      where: { id: t1.id },
      data: { status: "done", finishedAt: new Date() },
    });
    await db.turn.update({
      where: { id: f1.id },
      data: { status: "running", promotedAt: new Date() },
    });
    await receipts.attachTurnReceipt({
      presenceId,
      turnId: f1.id,
      channel: "D905",
      messageTs: "900.0001",
      text: "promoted predecessor",
    });
    const f2 = await db.turn.create({
      data: {
        conversationId,
        message: "newest message",
        status: "joining",
        followUpOfTurnId: f1.id,
        source: "slack",
      },
      select: { id: true },
    });

    await receipts.moveTurnReceipt({
      presenceId,
      followUpTurnId: f2.id,
      conversationId,
      channel: "D905",
      messageTs: "900.0002",
      text: "newest message",
    });

    const moved = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: f2.id },
    });
    expect(moved.messageTs).toBe("900.0002");
    expect(
      await db.channelTurnReceipt.findUnique({ where: { turnId: f1.id } }),
    ).toBeNull();
  });

  it("a move with nothing to move falls back to a plain attach", async () => {
    // The web-opened case: the target turn never had a mark (web sends get
    // no receipt), so the follow-up gets a fresh one, chooser and all.
    const { agentId, presenceId } = await seedChannelAgent(
      "receipt-move-fresh",
      {
        presenceCredentials: await getCrypto().encrypt(
          JSON.stringify({ botToken: "xoxb-move-fresh" }),
        ),
      },
    );
    slackHandlers["reactions.add"] = () => ({ ok: true });
    const { conversationId, followUp } = await seedMoveFamily(agentId, "D902");

    await receipts.moveTurnReceipt({
      presenceId,
      followUpTurnId: followUp.id,
      conversationId,
      channel: "D902",
      messageTs: "700.0002",
      text: "hello",
    });

    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: followUp.id },
    });
    expect(row.messageTs).toBe("700.0002");
  });

  it("the answer-post clear takes the WHOLE family off: the turn's mark and its joined follow-ups'", async () => {
    // The mark may sit on a follow-up's message by post time (it moved
    // there) — clearing only the finished turn's id would leave a stale
    // "seen" on the last follow-up forever.
    const { agentId, presenceId } = await seedChannelAgent("receipt-family", {
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-family" }),
      ),
    });
    slackHandlers["reactions.add"] = () => ({ ok: true });
    slackHandlers["reactions.remove"] = () => ({ ok: true });
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "D903" },
      select: { id: true },
    });
    const target = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "q",
        status: "done",
        source: "slack",
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    const joined = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "follow-up",
        status: "joined",
        followUpOfTurnId: target.id,
        source: "slack",
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    // The mark moved onto the follow-up's message mid-run.
    await receipts.attachTurnReceipt({
      presenceId,
      turnId: joined.id,
      channel: "D903",
      messageTs: "800.0002",
      text: "follow-up",
    });

    await receipts.clearTurnReceipts(target.id);

    expect(
      await db.channelTurnReceipt.findUnique({ where: { turnId: joined.id } }),
    ).toBeNull();
    const remove = slackCallsFor("reactions.remove").at(-1)!;
    expect(remove.form.get("timestamp")).toBe("800.0002");
  });

  it("prunes receipts older than the window on insert", async () => {
    // MUTATION-TESTED: drop the prune deleteMany in attachTurnReceipt and the
    // planted ancient row below survives — the ledger becomes a log.
    const { presenceId } = await seedChannelAgent("receipt-prune", {
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-prune" }),
      ),
    });
    slackHandlers["reactions.add"] = () => ({ ok: true });
    await db.channelTurnReceipt.create({
      data: {
        turnId: "turn-ancient",
        agentChannelId: presenceId,
        channel: "D1",
        messageTs: "1.1",
        reaction: "eyes",
      },
    });
    await db.$executeRaw`UPDATE channel_turn_receipts SET created_at = now() - interval '25 hours' WHERE turn_id = 'turn-ancient'`;

    await receipts.attachTurnReceipt({
      presenceId,
      turnId: "turn-fresh",
      channel: "D1",
      messageTs: "2.2",
      text: "hi",
    });

    await vi.waitFor(async () => {
      expect(
        await db.channelTurnReceipt.findUnique({
          where: { turnId: "turn-ancient" },
        }),
      ).toBeNull();
    });
    expect(
      await db.channelTurnReceipt.findUnique({
        where: { turnId: "turn-fresh" },
      }),
    ).not.toBeNull();
  });

  it("an accepted DM gets a receipt with the MODEL's allowlisted pick", async () => {
    // The seeded agent HAS a granted anthropic key, so the chooser makes a
    // real (faked) inference call; the fake answers an allowlisted name and
    // that exact reaction lands on the message.
    const { presenceId, integrationId } = await seedChannelAgent(
      "receipt-pick",
      {
        presenceCredentials: await getCrypto().encrypt(
          JSON.stringify({ botToken: "xoxb-pick" }),
        ),
      },
    );
    await linkUser(integrationId, "U777", MEMBER);
    // The generic seed stores an undecryptable placeholder value; the chooser
    // needs a REAL ciphertext to get past its fenced read and actually call
    // the (faked) model.
    await db.secret.updateMany({
      where: {
        workspaceId: WORKSPACE,
        type: "anthropic",
        name: { endsWith: "receipt-pick" },
      },
      data: { encryptedValue: await getCrypto().encrypt("sk-ant-api-fake") },
    });
    slackHandlers["reactions.add"] = () => ({ ok: true });
    slackHandlers["v1/messages"] = () => ({
      content: [{ type: "text", text: "rocket" }],
    });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U777", "D777", "ship the release"),
      eventId: "Ev-receipt-pick",
    });
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");
    if (result.outcome.kind !== "turn") throw new Error("unreachable");
    const turnId = result.outcome.turn.id;

    // The receipt task is detached — poll for its result.
    await vi.waitFor(async () => {
      const row = await db.channelTurnReceipt.findUnique({
        where: { turnId },
      });
      expect(row?.reaction).toBe("rocket");
    });
    const add = slackCallsFor("reactions.add").at(-1)!;
    expect(add.form.get("name")).toBe("rocket");
    expect(add.form.get("timestamp")).toBe("1000.0001");
  });

  it("a DOOR-FAILED turn gets NO receipt — its error is the answer, not a 'seen' mark", async () => {
    // MUTATION-TESTED: delete the `outcome.turn.errorCode` guard in
    // dispatch's receiptForAcceptedTurn and the no-key turn below gains a
    // receipt row.
    const { presenceId, integrationId } = await seedChannelAgent(
      "receipt-doorfail",
      {
        withoutKey: true,
        presenceCredentials: await getCrypto().encrypt(
          JSON.stringify({ botToken: "xoxb-doorfail" }),
        ),
      },
    );
    await linkUser(integrationId, "U778", MEMBER);
    slackHandlers["reactions.add"] = () => ({ ok: true });

    const result = await dispatch.dispatchSlackEvent({
      presenceId,
      identityRef: "UBOT",
      event: dmEvent("U778", "D778", "hello?"),
      eventId: "Ev-receipt-doorfail",
    });
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");
    if (result.outcome.kind !== "turn") throw new Error("unreachable");
    expect(result.outcome.turn.errorCode).toBe("no_model_key");
    const turnId = result.outcome.turn.id;

    // Give a (wrong) detached task every chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      await db.channelTurnReceipt.findUnique({ where: { turnId } }),
    ).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("turn narration (the live task card)", () => {
  const seedSessionReceipt = async (
    turnId: string,
    cardThreadTs: string | null = null,
  ) => {
    const { presenceId } = await seedChannelAgent(`narrate-${turnId}`, {
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-narrate" }),
      ),
    });
    await db.channelTurnReceipt.create({
      data: {
        turnId,
        agentChannelId: presenceId,
        channel: "D950",
        messageTs: "900.0001",
        cardThreadTs,
        kind: "session",
      },
    });
    return presenceId;
  };

  const planOf = (raw: string) => {
    const blocks = JSON.parse(
      new URLSearchParams(raw).get("blocks") ?? "[]",
    ) as {
      type: string;
      title: string;
      tasks: { title: string; status: string }[];
    }[];
    return blocks[0]!;
  };

  const pastThrottle = (turnId: string) =>
    db.channelTurnReceipt.update({
      where: { turnId },
      data: { cardAt: new Date(Date.now() - 10_000) },
    });

  it("a DM gets NO native loader — the card is the whole signal", async () => {
    // Slack's agent-session status opens a thread in a DM ("calling
    // setStatus on that thread will automatically open the thread for the
    // user"), and it only says the agent is busy. The card says WHAT it is
    // doing and sits inline, so the enum costs a thread and buys nothing.
    //
    // MUTATION-PROOF: drop the `narratesInline` arm and this fails —
    // every DM turn would open a thread again.
    const { presenceId } = await seedChannelAgent("dm-no-enum", {
      appMode: "agent",
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-dm" }),
      ),
    });
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });
    slackHandlers["reactions.add"] = () => ({ ok: true });

    await receipts.attachTurnReceipt({
      presenceId,
      turnId: "turn-dm-no-enum",
      channel: "D970",
      messageTs: "980.0001",
      threadTs: "980.0001",
      replyThreadTs: null,
      unthreaded: true,
      text: "hey",
    });

    expect(slackCallsFor("agents.sessions.setStatus")).toHaveLength(0);
    // ...but the receipt still exists, because it is what the card hangs
    // off. Losing it would lose the narration with the loader.
    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: "turn-dm-no-enum" },
    });
    expect(row.kind).toBe("session");
    expect(row.workStatusSet).toBe(false);

    // And a SEEN mark lands on the user's own message, beside the card.
    // The card is a separate message; without this, nothing acknowledges
    // the line they actually typed.
    // MUTATION-PROOF: drop the seen-mark arm and this fails.
    const marked = slackCallsFor("reactions.add").at(-1)!;
    expect(marked.form.get("timestamp")).toBe("980.0001");
    expect(row.reaction).not.toBeNull();
    // Its address is stored, because `messageTs` on a session row is the
    // thread root — unreacting there on clear would miss.
    expect(row.seenMessageTs).toBe("980.0001");
  });

  it("the clear does NOT set a status that was never set", async () => {
    // A card-only DM has no loader to take down. Calling the enum on the
    // clear would turn one ON at the very moment the turn ends — and in a
    // DM that also opens the thread this whole path exists to avoid.
    //
    // MUTATION-PROOF: drop `&& receipt.workStatusSet` and this fails.
    const { presenceId } = await seedChannelAgent("dm-clear-no-enum", {
      appMode: "agent",
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-dm" }),
      ),
    });
    await db.channelTurnReceipt.create({
      data: {
        turnId: "turn-dm-clear",
        agentChannelId: presenceId,
        channel: "D971",
        messageTs: "981.0001",
        kind: "session",
        workStatusSet: false,
      },
    });
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });

    await receipts.clearTurnReceipt("turn-dm-clear");

    expect(slackCallsFor("agents.sessions.setStatus")).toHaveLength(0);
    // ...and the row still goes, so nothing is left behind.
    expect(
      await db.channelTurnReceipt.findUnique({
        where: { turnId: "turn-dm-clear" },
      }),
    ).toBeNull();
  });

  it("a DM THREAD gets the native loader — it already has a thread", async () => {
    // A reply typed inside a DM thread has a real thread to hang the loader
    // on, so the top-level DM's card-instead-of-loader rule does not apply:
    // the person is reading that thread, and the loader is what says the
    // agent is working in it.
    //
    // MUTATION-PROOF: key the skip off the DOOR (every direct call) instead
    // of the ADDRESS and this fails.
    const { presenceId } = await seedChannelAgent("dm-thread-enum", {
      appMode: "agent",
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-dm-thread" }),
      ),
    });
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });

    await receipts.attachTurnReceipt({
      presenceId,
      turnId: "turn-dm-thread-enum",
      channel: "D972",
      messageTs: "982.0009",
      threadTs: "982.0001",
      replyThreadTs: "982.0001",
      unthreaded: false,
      text: "in the thread",
    });

    const status = slackCallsFor("agents.sessions.setStatus");
    expect(status).toHaveLength(1);
    // Scoped to the THREAD the person is reading.
    expect(status[0]!.form.get("thread_ts")).toBe("982.0001");
    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: "turn-dm-thread-enum" },
    });
    expect(row.workStatusSet).toBe(true);
    // And the narration card belongs in that same thread.
    expect(row.cardThreadTs).toBe("982.0001");
  });

  it("a CHANNEL still gets the native loader", async () => {
    // The conversation is threaded anyway, and the loader is what surfaces
    // the agent in the channel list. MUTATION-PROOF: widen the DM arm to
    // every conversation and this fails.
    const { presenceId } = await seedChannelAgent("channel-keeps-enum", {
      appMode: "agent",
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-ch" }),
      ),
    });
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });

    await receipts.attachTurnReceipt({
      presenceId,
      turnId: "turn-channel-enum",
      channel: "C970",
      messageTs: "980.0002",
      threadTs: "980.0001",
      replyThreadTs: "980.0001",
      unthreaded: false,
      text: "hey",
    });

    expect(slackCallsFor("agents.sessions.setStatus")).toHaveLength(1);
    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: "turn-channel-enum" },
    });
    expect(row.workStatusSet).toBe(true);
  });

  it("posts the card TOP-LEVEL in a DM — no thread is opened", async () => {
    await seedSessionReceipt("turn-card-dm");
    slackHandlers["chat.postMessage"] = () => ({
      ok: true,
      channel: "D950",
      ts: "950.5001",
    });

    await receipts.narrateTurnActivity("turn-card-dm", "Running a command");

    const posted = slackCallsFor("chat.postMessage").at(-1)!;
    // The whole point of the card over Slack's streaming methods: those
    // demand a thread root, which in a DM means a thread per turn.
    // MUTATION-PROOF: pass the session root as the card's thread and this
    // fails.
    expect(posted.form.get("thread_ts")).toBeNull();
    expect(planOf(posted.raw).tasks).toEqual([
      { task_id: "t0", title: "Running a command", status: "in_progress" },
    ]);
  });

  it("posts the card IN THREAD for a group mention", async () => {
    // A channel mention already answers in a thread, so the card belongs
    // there beside the answer rather than in the channel at large.
    await seedSessionReceipt("turn-card-group", "700.0009");
    slackHandlers["chat.postMessage"] = () => ({
      ok: true,
      channel: "D950",
      ts: "950.5002",
    });

    await receipts.narrateTurnActivity("turn-card-group", "Running a command");

    expect(
      slackCallsFor("chat.postMessage").at(-1)!.form.get("thread_ts"),
    ).toBe("700.0009");
  });

  it("UPDATES the one card as work moves, finishing the earlier steps", async () => {
    await seedSessionReceipt("turn-card-steps");
    slackHandlers["chat.postMessage"] = () => ({
      ok: true,
      channel: "D950",
      ts: "950.5003",
    });
    slackHandlers["chat.update"] = () => ({ ok: true });

    await receipts.narrateTurnActivity("turn-card-steps", "Running a command");
    await pastThrottle("turn-card-steps");
    await receipts.narrateTurnActivity("turn-card-steps", "Reading a file");

    // ONE card: a second post would leave the first stranded.
    expect(slackCallsFor("chat.postMessage")).toHaveLength(1);
    const updated = slackCallsFor("chat.update").at(-1)!;
    expect(updated.form.get("ts")).toBe("950.5003");
    // Every step but the newest is finished by definition — the agent moved
    // on from it.
    expect(planOf(updated.raw).tasks).toEqual([
      { task_id: "t0", title: "Running a command", status: "complete" },
      { task_id: "t1", title: "Reading a file", status: "in_progress" },
    ]);
    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: "turn-card-steps" },
    });
    expect(row.cardTs).toBe("950.5003");
    expect(row.cardSteps).toEqual(["Running a command", "Reading a file"]);
  });

  it("says nothing twice for the same step", async () => {
    await seedSessionReceipt("turn-card-repeat");
    slackHandlers["chat.postMessage"] = () => ({
      ok: true,
      channel: "D950",
      ts: "950.5004",
    });
    slackHandlers["chat.update"] = () => ({ ok: true });

    await receipts.narrateTurnActivity("turn-card-repeat", "Running a command");
    await pastThrottle("turn-card-repeat");
    await receipts.narrateTurnActivity("turn-card-repeat", "Running a command");

    expect(slackCallsFor("chat.update")).toHaveLength(0);
  });

  it("THROTTLES: an agent alternating tools cannot hammer Slack", async () => {
    await seedSessionReceipt("turn-card-throttle");
    slackHandlers["chat.postMessage"] = () => ({
      ok: true,
      channel: "D950",
      ts: "950.5005",
    });
    slackHandlers["chat.update"] = () => ({ ok: true });

    // read → bash → read: the step CHANGES every call, so repeat
    // suppression alone would let all three through.
    // MUTATION-PROOF: remove the interval check and this fails.
    await receipts.narrateTurnActivity("turn-card-throttle", "Reading a file");
    await receipts.narrateTurnActivity(
      "turn-card-throttle",
      "Running a command",
    );
    await receipts.narrateTurnActivity("turn-card-throttle", "Reading a file");
    expect(slackCallsFor("chat.update")).toHaveLength(0);

    // ...and once the floor passes, narration resumes: the throttle delays a
    // step, it never silences the turn.
    await pastThrottle("turn-card-throttle");
    await receipts.narrateTurnActivity(
      "turn-card-throttle",
      "Searching the web",
    );
    expect(slackCallsFor("chat.update")).toHaveLength(1);
  });

  it("REMOVES the card when the answer posts — a loader is not a reply", async () => {
    await seedSessionReceipt("turn-card-clear");
    slackHandlers["chat.postMessage"] = () => ({
      ok: true,
      channel: "D950",
      ts: "950.5006",
    });
    slackHandlers["chat.delete"] = () => ({ ok: true });
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });

    await receipts.narrateTurnActivity("turn-card-clear", "Running a command");
    await receipts.clearTurnReceipt("turn-card-clear");

    // MUTATION-PROOF: drop the removal from the clear path and this fails —
    // every turn would end with a stale card beside its answer.
    const deleted = slackCallsFor("chat.delete").at(-1)!;
    expect(deleted.form.get("ts")).toBe("950.5006");
    expect(
      await db.channelTurnReceipt.findUnique({
        where: { turnId: "turn-card-clear" },
      }),
    ).toBeNull();
  });

  it("the stale sweep removes an ABANDONED card", async () => {
    await seedSessionReceipt("turn-card-sweep");
    slackHandlers["chat.delete"] = () => ({ ok: true });
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });
    // A turn whose process died mid-run: nothing else will ever take its
    // card down.
    await db.channelTurnReceipt.update({
      where: { turnId: "turn-card-sweep" },
      data: {
        cardTs: "950.5007",
        cardSteps: ["Running a command"],
        createdAt: new Date(Date.now() - 11 * 60 * 1000),
      },
    });

    await receipts.sweepStaleSessionReceipts();

    expect(slackCallsFor("chat.delete")).toHaveLength(1);
  });

  it("REGRESSION (live 2026-09-02): a threaded mid-run follow-up keeps narrating", async () => {
    // Reported live (agent "Mona"): a Slack reply that folded into a running
    // turn left the progress card frozen on whatever step preceded it.
    //
    // The supervisor narrates under the turn it is RUNNING — a steer never
    // moves `runtime.activeTurnId` — so a receipt re-keyed to the follow-up
    // put the row out of `narrateTurnActivity`'s reach and it returned
    // silently (no log, no error: it looked exactly like a healthy no-op).
    //
    // MUTATION-PROOF: re-key the session row in `moveTurnReceipt` and this
    // fails — no `chat.update` is made and the card stops at "Reading a file".
    const { agentId, presenceId } = await seedChannelAgent("narrate-followup", {
      appMode: "agent",
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-narrate-followup" }),
      ),
    });
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });
    slackHandlers["chat.postMessage"] = () => ({
      ok: true,
      channel: "C960",
      ts: "960.5001",
    });
    slackHandlers["chat.update"] = () => ({ ok: true });
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "C960" },
      select: { id: true },
    });
    const target = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "the first message",
        status: "running",
        source: "slack",
      },
      select: { id: true },
    });
    const followUp = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "the follow-up",
        status: "joining",
        followUpOfTurnId: target.id,
        source: "slack",
      },
      select: { id: true },
    });

    await receipts.attachTurnReceipt({
      presenceId,
      turnId: target.id,
      channel: "C960",
      messageTs: "960.0001",
      threadTs: "960.0001",
      replyThreadTs: "960.0001",
      unthreaded: false,
      text: "the first message",
    });
    await receipts.narrateTurnActivity(target.id, "Reading a file");
    expect(slackCallsFor("chat.postMessage")).toHaveLength(1);

    await receipts.moveTurnReceipt({
      presenceId,
      followUpTurnId: followUp.id,
      conversationId: conversation.id,
      channel: "C960",
      messageTs: "960.0002",
      threadTs: "960.0001",
      replyThreadTs: "960.0001",
      unthreaded: false,
      text: "the follow-up",
    });

    // Wind the card's clock back so the 1.5s narration throttle cannot be
    // what answers here — without this the assertion passes either way.
    await db.channelTurnReceipt.update({
      where: { turnId: target.id },
      data: { cardAt: new Date(Date.now() - 10_000) },
    });
    const updatesBefore = slackCallsFor("chat.update").length;

    // The supervisor reports the next tool under the RUNNING turn's id.
    await receipts.narrateTurnActivity(target.id, "Running a command");

    // The card keeps moving.
    expect(slackCallsFor("chat.update")).toHaveLength(updatesBefore + 1);
    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: target.id },
    });
    expect(row.cardSteps).toEqual(["Reading a file", "Running a command"]);
  });

  it("REGRESSION (live 2026-09-02): a DM follow-up before the first tool still gets its card", async () => {
    // The reported shape: the follow-up landed BEFORE the turn ran any tool,
    // so the row was already re-keyed when the first narration arrived and no
    // card was ever posted — Slack showed nothing at all for the whole turn,
    // while the web transcript showed the agent working.
    //
    // A top-level DM has no native loader (the card is the whole signal),
    // which is why this shape was total silence rather than a frozen card.
    const { agentId, presenceId } = await seedChannelAgent("narrate-dm-first", {
      appMode: "agent",
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-narrate-dm-first" }),
      ),
    });
    slackHandlers["agents.sessions.setStatus"] = () => ({ ok: true });
    slackHandlers["reactions.add"] = () => ({ ok: true });
    slackHandlers["chat.postMessage"] = () => ({
      ok: true,
      channel: "D961",
      ts: "961.5001",
    });
    const conversation = await db.conversation.create({
      data: { agentId, source: "slack", externalRef: "D961" },
      select: { id: true },
    });
    const target = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "hey",
        status: "running",
        source: "slack",
      },
      select: { id: true },
    });
    const followUp = await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "and this too",
        status: "joining",
        followUpOfTurnId: target.id,
        source: "slack",
      },
      select: { id: true },
    });

    await receipts.attachTurnReceipt({
      presenceId,
      turnId: target.id,
      channel: "D961",
      messageTs: "961.0001",
      threadTs: "961.0001",
      replyThreadTs: null,
      unthreaded: true,
      text: "hey",
    });
    // The follow-up arrives before any tool has run.
    await receipts.moveTurnReceipt({
      presenceId,
      followUpTurnId: followUp.id,
      conversationId: conversation.id,
      channel: "D961",
      messageTs: "961.0002",
      threadTs: "961.0001",
      replyThreadTs: null,
      unthreaded: true,
      text: "and this too",
    });

    const postsBefore = slackCallsFor("chat.postMessage").length;
    await receipts.narrateTurnActivity(target.id, "Writing a file");

    // The card IS posted — inline, no thread opened in the DM.
    // MUTATION-PROOF: re-key the session row and this fails at zero posts.
    expect(slackCallsFor("chat.postMessage")).toHaveLength(postsBefore + 1);
    const posted = slackCallsFor("chat.postMessage").at(-1)!;
    expect(posted.form.get("thread_ts")).toBeNull();
    expect(planOf(posted.raw).tasks).toEqual([
      { task_id: "t0", title: "Writing a file", status: "in_progress" },
    ]);
    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: target.id },
    });
    expect(row.cardTs).toBe("961.5001");
    expect(row.cardSteps).toEqual(["Writing a file"]);
  });

  it("leaves the row alone when the workspace REFUSES to narrate", async () => {
    await seedSessionReceipt("turn-card-refused");
    slackHandlers["chat.postMessage"] = () => ({
      ok: false,
      error: "channel_type_not_supported",
    });

    await receipts.narrateTurnActivity(
      "turn-card-refused",
      "Running a command",
    );

    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: "turn-card-refused" },
    });
    // Nothing recorded: a later clear must not try to remove a card that was
    // never posted, and the steps must not claim a row the reader cannot see.
    expect(row.cardTs).toBeNull();
    expect(row.cardSteps).toEqual([]);
  });

  it("posts ONE card when two batches race", async () => {
    await seedSessionReceipt("turn-card-race");
    let posts = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    slackHandlers["chat.postMessage"] = async () => {
      posts += 1;
      // Hold the first post inside Slack, so the second caller runs its own
      // claim while the first is still in flight — the only window where the
      // race exists.
      if (posts === 1) await held;
      return { ok: true, channel: "D950", ts: `950.600${posts}` };
    };
    slackHandlers["chat.update"] = () => ({ ok: true });

    const first = receipts.narrateTurnActivity(
      "turn-card-race",
      "Running a command",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Clear the throttle stamp WITHOUT touching the steps, so the rate floor
    // cannot be what stops the second caller and the claim stands alone.
    await db.channelTurnReceipt.update({
      where: { turnId: "turn-card-race" },
      data: { cardAt: null },
    });
    await receipts.narrateTurnActivity("turn-card-race", "Reading a file");
    release?.();
    await first;

    // MUTATION-PROOF: drop the claim's verdict check and this reads 2 — two
    // cards for one turn, one of them orphaned.
    expect(posts).toBe(1);
  });

  it("no step is LOST when two batches update one card together", async () => {
    // The claim's job once a card exists. Two callers read the same
    // revision, each builds its own list from it, and the loser must stand
    // down — otherwise its list (which never contained the winner's step)
    // overwrites the winner's, and a step silently disappears from the card.
    //
    // MUTATION-PROOF: drop `if (claimed.count === 0) return;` and this
    // fails — the card ends up showing only one of the two steps.
    await seedSessionReceipt("turn-card-lost");
    slackHandlers["chat.postMessage"] = () => ({
      ok: true,
      channel: "D950",
      ts: "950.7001",
    });
    let updates = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    slackHandlers["chat.update"] = async () => {
      updates += 1;
      if (updates === 1) await held;
      return { ok: true };
    };

    // A card already exists, with one step on it.
    await receipts.narrateTurnActivity("turn-card-lost", "Running a command");
    await pastThrottle("turn-card-lost");

    // Two updates in flight over the same revision.
    const first = receipts.narrateTurnActivity(
      "turn-card-lost",
      "Reading a file",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db.channelTurnReceipt.update({
      where: { turnId: "turn-card-lost" },
      data: { cardAt: null },
    });
    await receipts.narrateTurnActivity("turn-card-lost", "Editing a file");
    release?.();
    await first;

    const row = await db.channelTurnReceipt.findUniqueOrThrow({
      where: { turnId: "turn-card-lost" },
    });
    // Both steps survive, in order. The claim runs BEFORE the provider call,
    // so a second caller reads the first's step and appends to it rather
    // than racing it — which is the property worth having: the card grows,
    // it never rewinds.
    expect(row.cardSteps).toEqual([
      "Running a command",
      "Reading a file",
      "Editing a file",
    ]);
  });

  it("never narrates onto a REACTION receipt — that mark is the fallback", async () => {
    const { presenceId } = await seedChannelAgent("narrate-reaction", {
      presenceCredentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-narrate" }),
      ),
    });
    await db.channelTurnReceipt.create({
      data: {
        turnId: "turn-card-reaction",
        agentChannelId: presenceId,
        channel: "D951",
        messageTs: "900.0002",
        kind: "reaction",
        reaction: "eyes",
      },
    });
    const before = slackCallsFor("chat.postMessage").length;

    await receipts.narrateTurnActivity(
      "turn-card-reaction",
      "Running a command",
    );

    expect(slackCallsFor("chat.postMessage")).toHaveLength(before);
  });
});

describe.skipIf(!PROOF_URL)("reportApprovalAuth", () => {
  it("flips active ↔ needs_attention, and ONLY from those states", async () => {
    const { presenceId } = await seedChannelAgent("health");

    await adapters.reportApprovalAuth(presenceId, false);
    expect(
      (await db.agentChannel.findUniqueOrThrow({ where: { id: presenceId } }))
        .status,
    ).toBe("needs_attention");

    await adapters.reportApprovalAuth(presenceId, true);
    expect(
      (await db.agentChannel.findUniqueOrThrow({ where: { id: presenceId } }))
        .status,
    ).toBe("active");

    // MUTATION-TESTED: the state filters in both updateMany WHEREs. Delete
    // them and a health report resurrects presences the user disabled or
    // that never finished setup.
    for (const [state, healthy] of [
      ["pending_setup", false],
      ["pending_setup", true],
      ["disabled", false],
      ["disabled", true],
    ] as const) {
      await db.agentChannel.update({
        where: { id: presenceId },
        data: { status: state },
      });
      await adapters.reportApprovalAuth(presenceId, healthy);
      expect(
        (
          await db.agentChannel.findUniqueOrThrow({
            where: { id: presenceId },
          })
        ).status,
      ).toBe(state);
    }
  });
});

describe.skipIf(!PROOF_URL)("approval prompts (restart-safe dedupe)", () => {
  it("first claim wins, the second answers claimed:false", async () => {
    const { presenceId } = await seedChannelAgent("prompt-claim");
    const input = {
      approvalId: "ap-claim",
      agentChannelId: presenceId,
      externalThreadId: "D1",
      expiresAt: null,
    };
    expect(await adapters.claimApprovalPrompt(input)).toEqual({
      claimed: true,
    });
    expect(await adapters.claimApprovalPrompt(input)).toEqual({
      claimed: false,
    });
  });

  it("stores the gateway's expiresAt at claim time and surfaces it in listUnsettledPrompts", async () => {
    // The restart-safe re-arm: a claim records the gateway's REAL deadline so a
    // restarted adapter re-arms the card against it instead of guessing (and
    // marking a still-live approval timed-out early). listUnsettledPrompts must
    // hand that deadline back.
    const { presenceId } = await seedChannelAgent("prompt-exp");
    const expiresAt = new Date("2026-08-06T18:00:00.000Z");
    expect(
      await adapters.claimApprovalPrompt({
        approvalId: "ap-exp",
        agentChannelId: presenceId,
        externalThreadId: "D1",
        expiresAt,
      }),
    ).toEqual({ claimed: true });

    const stored = await db.channelApprovalPrompt.findUniqueOrThrow({
      where: { approvalId: "ap-exp" },
      select: { expiresAt: true },
    });
    expect(stored.expiresAt).toEqual(expiresAt);

    const caller = await seedClaimedCaller();
    const unsettled = await adapters.listUnsettledPrompts(caller.adapterId);
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]).toMatchObject({
      approvalId: "ap-exp",
      expiresAt,
    });
  });

  it("settle returns the update handle and flips the state; unknown ids answer null", async () => {
    const { presenceId } = await seedChannelAgent("prompt-settle");
    await adapters.claimApprovalPrompt({
      approvalId: "ap-settle",
      agentChannelId: presenceId,
      externalThreadId: "D1",
      expiresAt: null,
    });
    await adapters.recordApprovalPromptMessage("ap-settle", "169.42");

    const settled = await adapters.settleApprovalPrompt("ap-settle", "expired");
    expect(settled).toEqual({
      externalMessageRef: "169.42",
      externalThreadId: "D1",
    });
    expect(
      (
        await db.channelApprovalPrompt.findUniqueOrThrow({
          where: { approvalId: "ap-settle" },
        })
      ).state,
    ).toBe("expired");
    const caller = await seedClaimedCaller();
    expect(await adapters.listUnsettledPrompts(caller.adapterId)).toEqual([]);

    expect(
      await adapters.settleApprovalPrompt("ap-nope", "decided"),
    ).toBeNull();
  });
});

// ── The approval decide flow ────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("decideApprovalFromChannel", () => {
  const SERVICE_KEY = `oc_${P}approvals-service-key`;

  const seedApprovable = async (suffix: string) => {
    const seeded = await seedChannelAgent(suffix);
    const key = await db.apiKey.create({
      data: {
        key: SERVICE_KEY,
        userId: ADMIN,
        userEmail: `${ADMIN}@example.com`,
        workspaceId: WORKSPACE,
        scope: "workspace",
        kind: "service",
      },
      select: { id: true },
    });
    await db.agentChannel.update({
      where: { id: seeded.presenceId },
      data: { apiKeyId: key.id },
    });
    await linkUser(seeded.integrationId, "U111", MEMBER);
    await db.channelApprovalPrompt.create({
      data: {
        approvalId: `ap-${suffix}`,
        agentChannelId: seeded.presenceId,
        externalThreadId: "D1",
        externalMessageRef: "169.1",
      },
    });
    return { ...seeded, approvalId: `ap-${suffix}` };
  };

  it("decides at the gateway with the SERVICE key and audits the CLICKER", async () => {
    const { presenceId, approvalId, agentId } = await seedApprovable("decide");

    const result = await approvals.decideApprovalFromChannel({
      presenceId,
      approvalId,
      decision: "approve",
      clickerExternalUserId: "U111",
    });

    expect(result).toEqual({ kind: "decided", decidedByName: "Morgan Member" });

    // The gateway saw the presence's service key deciding THAT approval.
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({
      path: `/v1/approvals/${approvalId}/decision`,
      auth: `Bearer ${SERVICE_KEY}`,
      body: { decision: "approve" },
    });

    // THE attribution row — MUTATION-TESTED: the gateway's own approved_by
    // can only name the key owner (ADMIN); the audit row must carry the
    // human who CLICKED. Delete the recordAuditEvent call (or stamp the key
    // owner) and this fails.
    const audit = await db.auditLog.findFirstOrThrow({
      where: { workspaceId: WORKSPACE, service: "channel", action: "approve" },
    });
    expect(audit.userId).toBe(MEMBER);
    expect(audit.userId).not.toBe(ADMIN);
    expect(audit.workspaceId).toBe(WORKSPACE);
    expect(audit.metadata).toMatchObject({
      approvalId,
      agentId,
      presenceId,
      decision: "approve",
    });

    // And the prompt settled.
    expect(
      (
        await db.channelApprovalPrompt.findUniqueOrThrow({
          where: { approvalId },
        })
      ).state,
    ).toBe("decided");
  });

  it("an UNAUTHORIZED gateway answer flips the presence to needs_attention", async () => {
    const { presenceId, approvalId } = await seedApprovable("unauth");
    gatewayRespond = () => ({ status: 401, body: {} });

    const result = await approvals.decideApprovalFromChannel({
      presenceId,
      approvalId,
      decision: "approve",
      clickerExternalUserId: "U111",
    });

    expect(result.kind).toBe("unavailable");
    expect(
      (await db.agentChannel.findUniqueOrThrow({ where: { id: presenceId } }))
        .status,
    ).toBe("needs_attention");
  });

  it("a 410 reads as already settled, and settles the prompt", async () => {
    const { presenceId, approvalId } = await seedApprovable("gone");
    gatewayRespond = () => ({ status: 410, body: {} });

    const result = await approvals.decideApprovalFromChannel({
      presenceId,
      approvalId,
      decision: "deny",
      clickerExternalUserId: "U111",
    });

    expect(result).toEqual({ kind: "already_settled" });
    expect(
      (
        await db.channelApprovalPrompt.findUniqueOrThrow({
          where: { approvalId },
        })
      ).state,
    ).toBe("decided");
  });

  it("REFUSES an unlinked clicker BEFORE the gateway is asked anything", async () => {
    // MUTATION-TESTED: the clicker authorization precedes the gateway call.
    // Delete the authorizeChannelUser fence and any Slack user who can see
    // the card decides with the presence's service key — the gateway call
    // count is the proof the fence held.
    const { presenceId, approvalId } = await seedApprovable("stranger");

    const result = await approvals.decideApprovalFromChannel({
      presenceId,
      approvalId,
      decision: "approve",
      clickerExternalUserId: "U999",
    });

    expect(result.kind).toBe("refused");
    expect(gatewayCalls).toHaveLength(0);
    expect(
      await db.auditLog.count({
        where: { workspaceId: WORKSPACE, service: "channel" },
      }),
    ).toBe(0);
  });

  it("a presence with no service key answers unavailable", async () => {
    const { integrationId, presenceId } = await seedChannelAgent("nokey-appr");
    await linkUser(integrationId, "U111", MEMBER);

    const result = await approvals.decideApprovalFromChannel({
      presenceId,
      approvalId: "ap-nokey",
      decision: "approve",
      clickerExternalUserId: "U111",
    });

    expect(result.kind).toBe("unavailable");
    expect(gatewayCalls).toHaveLength(0);
  });
});
