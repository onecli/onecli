import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomBytes } from "crypto";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

// Org-admin is the one branch in the share fence; the rest is SQL. Toggle it
// per test: true = an org admin, false = a plain member.
const role = vi.hoisted(() => ({ admin: true }));
vi.mock("./workspace-access-check", () => ({
  userIsOrgAdmin: async () => role.admin,
  canAccessWorkspaceAsUser: async () => true,
}));

const USER = "ghshare-user";
const caller = (target: { workspaceId?: string; organizationId?: string }) => ({
  organizationId: ORG,
  userId: USER,
  target,
});

/**
 * GitHub App installations on REAL PostgreSQL: one connection per org.
 *
 * Proves the model: sharing moves the connection up to the org (same id and
 * key, no copy); a GitHub account is never connected twice in one org;
 * deleting any connection removes only that one (older copies get the key
 * and stay); only org admins may share or edit repos; another tenant's
 * installation is never offered, shared or found. GitHub's HTTP API is the
 * only stub.
 *
 *   POLICY_PROOF_DATABASE_URL=postgresql://… pnpm --filter @onecli/api test -- \
 *     --run src/services/github-app-share-service.pg.test.ts
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Share = typeof import("./github-app-share-service");
type Conn = typeof import("./connection-service");

let db: Db;
let share: Share;
let conns: Conn;

const P = "ghshare-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WS_A = `${P}ws-a`;
const WS_B = `${P}ws-b`;
const WS_OTHER = `${P}ws-other`;

const GRANTED = ["acme/api", "acme/web", "acme/docs"];

// A real RSA key: the service signs an app JWT before calling GitHub.
let privateKey = "";

const mockGitHub = () => {
  const mintBodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        mintBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return new Response(
          JSON.stringify({
            token: "ghs_test",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: { contents: "write", metadata: "read" },
          }),
          { status: 201 },
        );
      }
      if (url.includes("/installation/repositories")) {
        return new Response(
          JSON.stringify({
            total_count: GRANTED.length,
            repositories: GRANTED.map((full_name) => ({ full_name })),
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return mintBodies;
};

const seedOriginal = async (
  scope: { workspaceId?: string; organizationId?: string },
  installationId: string,
  account: string,
) =>
  conns.createConnection(
    scope,
    "github-app",
    {
      type: "github_app",
      installation_id: installationId,
      app_id: "123",
      private_key: privateKey,
      access_token: "ghs_seed",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
    {
      metadata: {
        username: account,
        accountType: "Organization",
        installationId,
        repositorySelection: "all",
        repos: GRANTED,
      },
    },
  );

const reset = async () => {
  await db.appConnection.deleteMany({
    where: {
      OR: [
        { organizationId: { in: [ORG, OTHER_ORG] } },
        { workspaceId: { in: [WS_A, WS_B, WS_OTHER] } },
      ],
    },
  });
  await db.workspace.deleteMany({
    where: { id: { in: [WS_A, WS_B, WS_OTHER] } },
  });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
  const { generateKeyPairSync } = await import("crypto");
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();

  ({ db } = await import("@onecli/db"));
  const { ensureEditionDefaults } = await import("../edition-defaults");
  ensureEditionDefaults();
  share = await import("./github-app-share-service");
  conns = await import("./connection-service");

  await reset();
  await db.organization.createMany({
    data: [
      { id: ORG, name: ORG, slug: ORG },
      { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
    ],
  });
  await db.workspace.createMany({
    data: [
      { id: WS_A, name: "A", organizationId: ORG },
      { id: WS_B, name: "B", organizationId: ORG },
      { id: WS_OTHER, name: "Other tenant", organizationId: OTHER_ORG },
    ],
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  role.admin = true;
  if (!PROOF_URL) return;
  await db.appConnection.deleteMany({
    where: {
      OR: [
        { organizationId: { in: [ORG, OTHER_ORG] } },
        { workspaceId: { in: [WS_A, WS_B, WS_OTHER] } },
      ],
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

/** A copy made the old way (before sharing moved connections up): built on
 * `source`'s installation, holding no signing key of its own. Existing data
 * can still have these. */
const seedLegacyCopy = async (
  scope: { workspaceId?: string; organizationId?: string },
  source: { id: string },
  installationId: string,
  account: string,
  repositories?: string[],
) => {
  const connection = await conns.createConnection(
    scope,
    "github-app",
    {
      type: "github_app",
      installation_id: installationId,
      app_id: "123",
      access_token: "ghs_copy",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      ...(repositories ? { repositories } : {}),
    },
    {
      metadata: { username: account, installationId, repos: GRANTED },
    },
  );
  await db.appConnection.update({
    where: { id: connection.id },
    data: { sourceConnectionId: source.id },
  });
  return connection;
};

const credsOf = async (id: string) => {
  const { getCrypto } = await import("../providers");
  const row = await db.appConnection.findUniqueOrThrow({ where: { id } });
  return {
    row,
    creds: JSON.parse(await getCrypto().decrypt(row.credentials ?? "")),
  };
};

describe.skipIf(!PROOF_URL)(
  "GitHub App installations: one connection per org",
  () => {
    it("lists the org's installations and whether each already reaches the caller", async () => {
      await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      const forB = await share.listSharedInstallations(
        caller({ workspaceId: WS_B }),
      );
      expect(forB).toHaveLength(1);
      expect(forB[0]).toMatchObject({
        account: "acme",
        connectedHere: 0,
      });
      const forA = await share.listSharedInstallations(
        caller({ workspaceId: WS_A }),
      );
      expect(forA[0]).toMatchObject({ connectedHere: 1 });
    });

    it("the same installation connected here too is represented by the caller's own original", async () => {
      await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      const orgRow = await seedOriginal({ organizationId: ORG }, "111", "acme");

      const forOrg = await share.listSharedInstallations(
        caller({ organizationId: ORG }),
      );
      expect(forOrg).toHaveLength(1);
      expect(forOrg[0]).toMatchObject({
        sourceConnectionId: orgRow.id,
        connectedHere: 1,
      });
    });

    it("sharing moves the connection up to the org: same id, key and repos, no copy", async () => {
      const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      const shared = await share.shareInstallationWithOrganization({
        caller: caller({ workspaceId: WS_B }),
        sourceConnectionId: original.id,
      });
      expect(shared.id).toBe(original.id);
      const { row, creds } = await credsOf(original.id);
      expect(row).toMatchObject({
        scope: "organization",
        organizationId: ORG,
        workspaceId: null,
        sourceConnectionId: null,
      });
      expect(creds.private_key).toBe(privateKey);
      expect(
        await db.appConnection.count({
          where: {
            provider: "github-app",
            OR: [
              { organizationId: ORG },
              { workspaceId: { in: [WS_A, WS_B] } },
            ],
          },
        }),
      ).toBe(1);
      // Now every workspace inherits it: nothing left to share.
      const forB = await share.listSharedInstallations(
        caller({ workspaceId: WS_B }),
      );
      expect(forB[0]).toMatchObject({
        connectedHere: 1,
      });
    });

    it("an installation already at the org level can't be shared again", async () => {
      const atOrg = await seedOriginal({ organizationId: ORG }, "222", "corp");
      await expect(
        share.shareInstallationWithOrganization({
          caller: caller({ workspaceId: WS_B }),
          sourceConnectionId: atOrg.id,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("never offers or shares another tenant's installation", async () => {
      const foreign = await seedOriginal(
        { workspaceId: WS_OTHER },
        "999",
        "rival",
      );
      expect(
        await share.listSharedInstallations(caller({ workspaceId: WS_B })),
      ).toEqual([]);
      await expect(
        share.shareInstallationWithOrganization({
          caller: caller({ workspaceId: WS_B }),
          sourceConnectionId: foreign.id,
        }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        // The share fence itself refuses (promote's own fence is a second
        // line, with its own message).
        message: "Installation not found",
      });
      expect((await credsOf(foreign.id)).row.scope).toBe("workspace");
    });

    it("a member can't list or share any installation", async () => {
      const inA = await seedOriginal({ workspaceId: WS_A }, "1", "in-a");
      role.admin = false;
      await expect(
        share.listSharedInstallations(caller({ workspaceId: WS_A })),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        share.shareInstallationWithOrganization({
          caller: caller({ workspaceId: WS_A }),
          sourceConnectionId: inA.id,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await credsOf(inA.id)).row.scope).toBe("workspace");
    });

    it("deleting a workspace connection never removes the org-level one built on it", async () => {
      // The mess this fixes: an org-level copy of a workspace's installation.
      const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      const atOrg = await seedLegacyCopy(
        { organizationId: ORG },
        original,
        "111",
        "acme",
      );
      const inB = await seedLegacyCopy(
        { workspaceId: WS_B },
        original,
        "111",
        "acme",
        ["acme/web"],
      );

      await conns.deleteConnection({ workspaceId: WS_A }, original.id);

      expect(await db.appConnection.count({ where: { id: original.id } })).toBe(
        0,
      );
      for (const copy of [atOrg, inB]) {
        const { row, creds } = await credsOf(copy.id);
        // Kept, unlinked, and now holding the key, so it keeps working.
        expect(row.sourceConnectionId).toBeNull();
        expect(creds.private_key).toBe(privateKey);
      }
      // Its own repo pin and token are untouched.
      expect((await credsOf(inB.id)).creds).toMatchObject({
        repositories: ["acme/web"],
        access_token: "ghs_copy",
      });
    });

    it("deleting a copy leaves the original alone", async () => {
      const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      const inB = await seedLegacyCopy(
        { workspaceId: WS_B },
        original,
        "111",
        "acme",
      );
      await conns.deleteConnection({ workspaceId: WS_B }, inB.id);
      expect(await db.appConnection.count({ where: { id: original.id } })).toBe(
        1,
      );
    });

    it("deleting the org-level connection removes only it", async () => {
      const atOrg = await seedOriginal({ organizationId: ORG }, "222", "corp");
      const inA = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      await conns.deleteConnection({ organizationId: ORG }, atOrg.id);
      expect(await db.appConnection.count({ where: { id: atOrg.id } })).toBe(0);
      expect(await db.appConnection.count({ where: { id: inA.id } })).toBe(1);
    });

    it("finds an installation wherever it lives in the org, and never in another", async () => {
      await seedOriginal({ workspaceId: WS_OTHER }, "111", "rival");
      expect(await conns.findInstallationConnection(ORG, "111")).toBeNull();
      const inA = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      expect(await conns.findInstallationConnection(ORG, "111")).toMatchObject({
        id: inA.id,
        scope: "workspace",
        workspaceId: WS_A,
      });
      expect(await conns.findInstallationConnection(ORG, undefined)).toBeNull();
    });

    it("connecting at the org level what a workspace has moves it up, then re-auths it in place", async () => {
      // The org callback's steps on real rows: find, move up, reconnect.
      const inA = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      const found = await conns.findInstallationConnection(ORG, "111");
      expect(found).toMatchObject({ id: inA.id, workspaceId: WS_A });
      await conns.promoteConnectionToOrganization(WS_A, ORG, inA.id);
      await conns.reconnectConnection(
        { organizationId: ORG },
        inA.id,
        {
          type: "github_app",
          installation_id: "111",
          app_id: "123",
          private_key: privateKey,
          access_token: "ghs_fresh",
        },
        { metadata: { username: "acme", installationId: "111" } },
      );
      expect(
        await db.appConnection.count({
          where: {
            provider: "github-app",
            OR: [
              { organizationId: ORG },
              { workspaceId: { in: [WS_A, WS_B] } },
            ],
          },
        }),
      ).toBe(1);
      const { row, creds } = await credsOf(inA.id);
      expect(row).toMatchObject({ scope: "organization", organizationId: ORG });
      expect(creds.access_token).toBe("ghs_fresh");
    });

    it("malformed credential JSON refuses without writes or plaintext in warning logs", async () => {
      const original = await seedOriginal(
        { organizationId: ORG },
        "111",
        "acme",
      );
      const { getCrypto } = await import("../providers");
      const { logger } = await import("../lib/logger");
      const sentinel = "CREDENTIAL_PLAINTEXT_SENTINEL_DO_NOT_LOG";
      const before = await db.appConnection.update({
        where: { id: original.id },
        data: {
          credentials: await getCrypto().encrypt(
            `{"access_token":"${sentinel}",INVALID}`,
          ),
        },
      });
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        for (const operation of [
          () =>
            share.getConnectionRepositories(
              caller({ organizationId: ORG }),
              original.id,
            ),
          () =>
            share.refreshConnectionRepositories(
              caller({ organizationId: ORG }),
              original.id,
            ),
          () =>
            share.setConnectionRepositories({
              caller: caller({ organizationId: ORG }),
              connectionId: original.id,
              repositories: ["acme/api"],
            }),
        ]) {
          await expect(operation()).rejects.toMatchObject({
            code: "UNPROCESSABLE",
          });
        }
        expect(
          await db.appConnection.findUniqueOrThrow({
            where: { id: original.id },
          }),
        ).toEqual(before);
        expect(warn).toHaveBeenCalled();
        expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
        expect(
          warn.mock.calls.every(
            (args) => args.length === 1 && typeof args[0] === "string",
          ),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it("a credential decrypt failure says so", async () => {
      const original = await seedOriginal(
        { organizationId: ORG },
        "111",
        "acme",
      );
      const providers = await import("../providers");
      const spy = vi
        .spyOn(providers.getCrypto(), "decrypt")
        .mockRejectedValueOnce(new Error("key service unavailable"));
      await expect(
        share.getConnectionRepositories(
          caller({ organizationId: ORG }),
          original.id,
        ),
      ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
      spy.mockRestore();
    });

    it("promote moves a workspace connection to the org in place", async () => {
      const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      const moved = await conns.promoteConnectionToOrganization(
        WS_A,
        ORG,
        original.id,
      );
      expect(moved.id).toBe(original.id);
      expect((await credsOf(original.id)).row).toMatchObject({
        scope: "organization",
        organizationId: ORG,
        workspaceId: null,
      });
    });

    it("promote refuses another tenant's, another workspace's, or an org row", async () => {
      const foreign = await seedOriginal({ workspaceId: WS_OTHER }, "9", "r");
      const inA = await seedOriginal({ workspaceId: WS_A }, "1", "a");
      const atOrg = await seedOriginal({ organizationId: ORG }, "2", "b");
      for (const [ws, id] of [
        [WS_A, foreign.id],
        [WS_B, inA.id],
        [WS_A, atOrg.id],
      ] as const) {
        await expect(
          conns.promoteConnectionToOrganization(ws, ORG, id),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
    });

    it("promote refuses a second org-level connection of the same installation", async () => {
      await seedOriginal({ organizationId: ORG }, "111", "acme");
      const inA = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      await expect(
        conns.promoteConnectionToOrganization(WS_A, ORG, inA.id),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect((await credsOf(inA.id)).row.scope).toBe("workspace");
    });

    it("serializes two original shares of the same installation so only one is promoted", async () => {
      const first = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      const second = await seedOriginal({ workspaceId: WS_B }, "111", "acme");
      mockGitHub();
      const results = await Promise.allSettled(
        [first, second].map((source) =>
          share.shareInstallationWithOrganization({
            caller: caller({ organizationId: ORG }),
            sourceConnectionId: source.id,
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(
        await db.appConnection.count({
          where: {
            scope: "organization",
            organizationId: ORG,
            provider: "github-app",
          },
        }),
      ).toBe(1);
      expect(
        await db.appConnection.count({
          where: { id: { in: [first.id, second.id] } },
        }),
      ).toBe(2);
    });

    it("promote refuses a legacy copy", async () => {
      const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      const inB = await seedLegacyCopy(
        { workspaceId: WS_B },
        original,
        "111",
        "acme",
      );
      await expect(
        conns.promoteConnectionToOrganization(WS_B, ORG, inB.id),
      ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    });

    // ── A connection's own repositories: see, refresh, change ────────────────

    it("an original connection can be narrowed to some repos and widened back to all", async () => {
      const original = await seedOriginal(
        { organizationId: ORG },
        "111",
        "acme",
      );
      const mintBodies = mockGitHub();
      const org = caller({ organizationId: ORG });

      const narrowed = await share.setConnectionRepositories({
        caller: org,
        connectionId: original.id,
        repositories: ["ACME/api"],
      });
      expect(narrowed).toEqual({ id: original.id, repositories: ["acme/api"] });
      // GitHub minted for exactly the pick; the gateway refreshes with the pin.
      expect(mintBodies.at(-1)).toEqual({ repositories: ["api"] });
      let { row, creds } = await credsOf(original.id);
      expect(creds.repositories).toEqual(["acme/api"]);
      // An original keeps its own signing key and everything else.
      expect(creds.private_key).toBe(privateKey);
      expect(creds.installation_id).toBe("111");
      expect(row.metadata).toMatchObject({
        repositorySelection: "selected",
        repos: ["acme/api"],
        username: "acme",
      });

      await share.setConnectionRepositories({
        caller: org,
        connectionId: original.id,
      });
      ({ row, creds } = await credsOf(original.id));
      expect(creds).not.toHaveProperty("repositories");
      expect(row.metadata).toMatchObject({
        repositorySelection: "all",
        repos: GRANTED,
      });
    });

    it("a legacy copy is re-pinned with its source's key and still holds none", async () => {
      const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      const mintBodies = mockGitHub();
      const shared = await seedLegacyCopy(
        { workspaceId: WS_B },
        original,
        "111",
        "acme",
        ["acme/web"],
      );
      await share.setConnectionRepositories({
        caller: caller({ workspaceId: WS_B }),
        connectionId: shared.id,
        repositories: ["acme/web", "acme/docs"],
      });
      expect(mintBodies.at(-1)).toEqual({ repositories: ["web", "docs"] });
      const { row, creds } = await credsOf(shared.id);
      expect(creds.repositories).toEqual(["acme/web", "acme/docs"]);
      expect(creds).not.toHaveProperty("private_key");
      expect(row.sourceConnectionId).toBe(original.id);
    });

    it("refresh reads the live list into the connection, so pickers aren't stale", async () => {
      const original = await seedOriginal(
        { organizationId: ORG },
        "111",
        "acme",
      );
      await db.appConnection.update({
        where: { id: original.id },
        data: { metadata: { username: "acme", repos: ["acme/old"] } },
      });
      mockGitHub();
      const before = await db.appConnection.findUniqueOrThrow({
        where: { id: original.id },
      });
      const readOnly = await share.getConnectionRepositories(
        caller({ organizationId: ORG }),
        original.id,
      );
      expect(readOnly.available).toEqual(GRANTED);
      expect(
        await db.appConnection.findUniqueOrThrow({
          where: { id: original.id },
        }),
      ).toEqual(before);
      const result = await share.refreshConnectionRepositories(
        caller({ organizationId: ORG }),
        original.id,
      );
      expect(result).toEqual({
        available: GRANTED,
        truncated: false,
        selected: null,
      });
      const { row } = await credsOf(original.id);
      expect(row.metadata).toMatchObject({ username: "acme", repos: GRANTED });
    });

    it.each(["refresh", "set"])(
      "%s refuses a concurrent credential edit instead of overwriting it",
      async (operation) => {
        const original = await seedOriginal(
          { organizationId: ORG },
          "111",
          "acme",
        );
        mockGitHub();
        const upstream = globalThis.fetch;
        const { getCrypto } = await import("../providers");
        const { creds } = await credsOf(original.id);
        const changed = await getCrypto().encrypt(
          JSON.stringify({
            ...creds,
            repositories: ["acme/web"],
            access_token: "concurrent-token",
          }),
        );
        let edited = false;
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: string | URL, init?: RequestInit) => {
            if (
              !edited &&
              String(input).includes("/installation/repositories")
            ) {
              edited = true;
              await db.appConnection.update({
                where: { id: original.id },
                data: {
                  credentials: changed,
                  metadata: {
                    repositorySelection: "selected",
                    repos: ["acme/web"],
                  },
                },
              });
            }
            return upstream(input, init);
          }),
        );
        const org = caller({ organizationId: ORG });
        const pending =
          operation === "refresh"
            ? share.refreshConnectionRepositories(org, original.id)
            : share.setConnectionRepositories({
                caller: org,
                connectionId: original.id,
                repositories: ["acme/api"],
              });
        await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
        const after = await db.appConnection.findUniqueOrThrow({
          where: { id: original.id },
        });
        expect(after.credentials).toBe(changed);
        expect(after.metadata).toEqual({
          repositorySelection: "selected",
          repos: ["acme/web"],
        });
      },
    );

    it("edit and refresh are fenced: another scope's or tenant's connection is not found", async () => {
      const inA = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
      const foreign = await seedOriginal(
        { workspaceId: WS_OTHER },
        "999",
        "evil",
      );
      const atOrg = await seedOriginal({ organizationId: ORG }, "222", "acme2");
      mockGitHub();
      const cases: [ReturnType<typeof caller>, string][] = [
        [caller({ workspaceId: WS_B }), inA.id], // another workspace's row
        [caller({ workspaceId: WS_A }), foreign.id], // another tenant's row
        [caller({ workspaceId: WS_A }), atOrg.id], // an org row via a workspace
        [caller({ organizationId: ORG }), inA.id], // a workspace row via the org
      ];
      for (const [who, id] of cases) {
        await expect(
          share.setConnectionRepositories({
            caller: who,
            connectionId: id,
            repositories: ["acme/api"],
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          share.getConnectionRepositories(who, id),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          share.refreshConnectionRepositories(who, id),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      const { creds } = await credsOf(foreign.id);
      expect(creds).not.toHaveProperty("repositories");
    });

    it("refuses an empty pick, a repo outside the installation, and a member", async () => {
      const original = await seedOriginal(
        { organizationId: ORG },
        "111",
        "acme",
      );
      mockGitHub();
      const org = caller({ organizationId: ORG });
      await expect(
        share.setConnectionRepositories({
          caller: org,
          connectionId: original.id,
          repositories: [],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        share.setConnectionRepositories({
          caller: org,
          connectionId: original.id,
          repositories: ["acme/secret"],
        }),
      ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
      role.admin = false;
      await expect(
        share.setConnectionRepositories({
          caller: org,
          connectionId: original.id,
          repositories: ["acme/api"],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const { creds } = await credsOf(original.id);
      expect(creds).not.toHaveProperty("repositories");
    });
  },
);
