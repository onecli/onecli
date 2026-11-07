import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * `loadOAuthConnection` on REAL PostgreSQL — the fence behind the dashboard's
 * live folder pickers (Google Drive, Dropbox). Those routes decrypt a stored
 * credential and call the provider with it, so whose connection a caller may
 * reach IS the security boundary: an org-scoped connection in the caller's
 * org, or a workspace connection in the caller's OWN workspace. Never another
 * workspace's (a colleague's personal Drive), never another org's — and either
 * refusal must read as NOT_FOUND, confirming nothing.
 *
 * Env-gated like the other proof suites; see testing/pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let svc: typeof import("./oauth-connection-token");

const P = "oct-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WS = `${P}ws`;
const OTHER_WS = `${P}other-ws`;
const FOREIGN_WS = `${P}foreign-ws`;
const MINE = `${P}conn-mine`;
const COLLEAGUE = `${P}conn-colleague`;
const ORG_CONN = `${P}conn-org`;
const FOREIGN = `${P}conn-foreign`;
const FOREIGN_ORG_CONN = `${P}conn-foreign-org`;
const DISCONNECTED = `${P}conn-disconnected`;

const reset = async () => {
  await db.appConnection.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
  ({ db } = await import("@onecli/db"));
  const { getCrypto } = await import("../../providers");
  svc = await import("./oauth-connection-token");
  await reset();

  for (const id of [ORG, OTHER_ORG]) {
    await db.organization.create({ data: { id, name: id, slug: id } });
  }
  for (const [id, organizationId] of [
    [WS, ORG],
    [OTHER_WS, ORG],
    [FOREIGN_WS, OTHER_ORG],
  ] as const) {
    await db.workspace.create({ data: { id, name: id, organizationId } });
  }
  const credentials = await getCrypto().encrypt(
    JSON.stringify({ access_token: "t", expires_at: 4_102_444_800 }),
  );
  const conn = (id: string, over: Record<string, unknown>) =>
    db.appConnection.create({
      data: {
        id,
        provider: "google-drive",
        status: "connected",
        credentials,
        ...over,
      } as never,
    });
  await conn(MINE, { scope: "workspace", workspaceId: WS });
  await conn(COLLEAGUE, { scope: "workspace", workspaceId: OTHER_WS });
  await conn(ORG_CONN, { scope: "organization", organizationId: ORG });
  await conn(FOREIGN, { scope: "workspace", workspaceId: FOREIGN_WS });
  await conn(FOREIGN_ORG_CONN, {
    scope: "organization",
    organizationId: OTHER_ORG,
  });
  await conn(DISCONNECTED, {
    scope: "workspace",
    workspaceId: WS,
    status: "disconnected",
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
});

const reach = async (
  scope: { organizationId: string; workspaceId?: string },
  id: string,
  provider = "google-drive",
) =>
  svc
    .loadOAuthConnection(scope, id, provider)
    .then(({ conn }) => conn.id)
    .catch((e: { code?: string }) => e.code ?? "THREW");

describe.skipIf(!PROOF_URL)("loadOAuthConnection — the picker fence", () => {
  const inWs = { organizationId: ORG, workspaceId: WS };

  it("reaches my workspace's connection and my org's, decrypted", async () => {
    expect(await reach(inWs, MINE)).toBe(MINE);
    expect(await reach(inWs, ORG_CONN)).toBe(ORG_CONN);
    const { creds } = await svc.loadOAuthConnection(inWs, MINE, "google-drive");
    expect(creds.access_token).toBe("t");
  });

  it("never reaches another workspace's connection in the same org", async () => {
    // The finding this suite exists for: org membership alone used to be
    // enough to browse a colleague's personal Drive.
    expect(await reach(inWs, COLLEAGUE)).toBe("NOT_FOUND");
    // Without a workspace in the request, NO workspace connection is visible.
    expect(await reach({ organizationId: ORG }, MINE)).toBe("NOT_FOUND");
    expect(await reach({ organizationId: ORG }, ORG_CONN)).toBe(ORG_CONN);
  });

  it("never reaches another org's connections, even naming its workspace", async () => {
    expect(await reach(inWs, FOREIGN)).toBe("NOT_FOUND");
    expect(await reach(inWs, FOREIGN_ORG_CONN)).toBe("NOT_FOUND");
    // A workspace id from another org paired with my org matches nothing.
    expect(
      await reach({ organizationId: ORG, workspaceId: FOREIGN_WS }, FOREIGN),
    ).toBe("NOT_FOUND");
  });

  it("is provider- and status-scoped", async () => {
    expect(await reach(inWs, MINE, "dropbox")).toBe("NOT_FOUND");
    expect(await reach(inWs, DISCONNECTED)).toBe("NOT_FOUND");
  });
});
