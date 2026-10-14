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
 * Shared GitHub App installations on REAL PostgreSQL.
 *
 * Proves what makes sharing safe: only an org admin may share (a member is
 * refused at every level); candidates come only from the caller's own org
 * (never another tenant's installation, even with its id); a shared
 * connection is pinned to a subset of what the installation grants and holds
 * no signing key; removing the original removes every connection built on it,
 * in any workspace; and a shared connection is never promoted or reused as a
 * source. GitHub's HTTP API is the only stub.
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

describe.skipIf(!PROOF_URL)("shared GitHub App installations", () => {
  it("a workspace-level install is offered to the other workspaces and the org level", async () => {
    await seedOriginal({ workspaceId: WS_A }, "111", "acme");

    const forB = await share.listSharedInstallations(
      caller({
        workspaceId: WS_B,
      }),
    );
    expect(forB).toHaveLength(1);
    expect(forB[0]).toMatchObject({
      account: "acme",
      origin: "another_workspace",
      connectedHere: 0,
    });

    const forOrg = await share.listSharedInstallations(
      caller({
        organizationId: ORG,
      }),
    );
    expect(forOrg[0]?.origin).toBe("another_workspace");

    const forA = await share.listSharedInstallations(
      caller({
        workspaceId: WS_A,
      }),
    );
    expect(forA[0]).toMatchObject({ origin: "this_scope", connectedHere: 1 });
  });

  it("never offers or accepts another tenant's installation", async () => {
    const foreign = await seedOriginal(
      { workspaceId: WS_OTHER },
      "999",
      "rival",
    );
    expect(
      await share.listSharedInstallations(caller({ workspaceId: WS_B })),
    ).toEqual([]);

    mockGitHub();
    await expect(
      share.createSharedConnection({
        caller: caller({ workspaceId: WS_B }),
        sourceConnectionId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      share.listInstallationRepos(caller({ workspaceId: WS_B }), foreign.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("pins the picked repos in the credentials and mints a token for exactly them", async () => {
    const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
    const mintBodies = mockGitHub();

    const created = await share.createSharedConnection({
      caller: caller({ workspaceId: WS_B }),
      sourceConnectionId: original.id,
      repositories: ["ACME/web"],
    });

    expect(mintBodies.at(-1)).toEqual({ repositories: ["web"] });
    const row = await db.appConnection.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.workspaceId).toBe(WS_B);
    expect(row.sourceConnectionId).toBe(original.id);
    const { getCrypto } = await import("../providers");
    const creds = JSON.parse(await getCrypto().decrypt(row.credentials ?? ""));
    // Canonical casing from GitHub, so the gateway's pin matches exactly.
    expect(creds.repositories).toEqual(["acme/web"]);
    expect(creds.installation_id).toBe("111");
    // The signing key stays only in the source row; the gateway borrows it.
    expect(creds).not.toHaveProperty("private_key");
    expect(row.metadata).toMatchObject({
      repositorySelection: "selected",
      tags: ["web"],
    });
  });

  it("refuses repos outside the installation and an empty pick", async () => {
    const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
    mockGitHub();
    await expect(
      share.createSharedConnection({
        caller: caller({ workspaceId: WS_B }),
        sourceConnectionId: original.id,
        repositories: ["acme/web", "acme/secret"],
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    await expect(
      share.createSharedConnection({
        caller: caller({ workspaceId: WS_B }),
        sourceConnectionId: original.id,
        repositories: [" "],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db.appConnection.count({ where: { workspaceId: WS_B } })).toBe(
      0,
    );
  });

  it("a shared connection can't itself be a source", async () => {
    const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
    mockGitHub();
    const derived = await share.createSharedConnection({
      caller: caller({ workspaceId: WS_B }),
      sourceConnectionId: original.id,
      repositories: ["acme/web"],
    });
    await expect(
      share.createSharedConnection({
        caller: caller({ organizationId: ORG }),
        sourceConnectionId: derived.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Still one installation on offer, represented by the original.
    const list = await share.listSharedInstallations(
      caller({
        organizationId: ORG,
      }),
    );
    expect(list.map((i) => i.sourceConnectionId)).toEqual([original.id]);
  });

  it("removing the original removes the connections built on it everywhere", async () => {
    const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
    mockGitHub();
    const inB = await share.createSharedConnection({
      caller: caller({ workspaceId: WS_B }),
      sourceConnectionId: original.id,
      repositories: ["acme/web"],
    });
    const atOrg = await share.createSharedConnection({
      caller: caller({ organizationId: ORG }),
      sourceConnectionId: original.id,
    });

    await conns.deleteConnection({ workspaceId: WS_A }, original.id);

    expect(
      await db.appConnection.count({
        where: { id: { in: [original.id, inB.id, atOrg.id] } },
      }),
    ).toBe(0);
  });

  it("a member can't list, read or share any installation, at any level", async () => {
    role.admin = false;
    const inA = await seedOriginal({ workspaceId: WS_A }, "1", "in-a");
    const atOrg = await seedOriginal({ organizationId: ORG }, "2", "at-org");
    mockGitHub();

    // Not even their own workspace's or the org's: a shared copy gets its own
    // id, so org rules bound to the original would not narrow it.
    for (const target of [{ workspaceId: WS_A }, { workspaceId: WS_B }]) {
      await expect(
        share.listSharedInstallations(caller(target)),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      for (const source of [inA.id, atOrg.id]) {
        await expect(
          share.listInstallationRepos(caller(target), source),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(
          share.createSharedConnection({
            caller: caller(target),
            sourceConnectionId: source,
            repositories: ["acme/web"],
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    }
    expect(
      await db.appConnection.count({
        where: { sourceConnectionId: { in: [inA.id, atOrg.id] } },
      }),
    ).toBe(0);
  });

  it("an org admin may build on any workspace's installation", async () => {
    role.admin = true;
    const inA = await seedOriginal({ workspaceId: WS_A }, "1", "in-a");
    mockGitHub();
    const built = await share.createSharedConnection({
      caller: caller({ workspaceId: WS_B }),
      sourceConnectionId: inA.id,
      repositories: ["acme/api"],
    });
    expect(built.sourceConnectionId).toBe(inA.id);
  });

  it("a re-auth gives a shared connection its own grant and unlinks it", async () => {
    const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
    mockGitHub();
    const inB = await share.createSharedConnection({
      caller: caller({ workspaceId: WS_B }),
      sourceConnectionId: original.id,
      repositories: ["acme/web"],
    });
    // A bare token persist (the gateway's refresh shape) keeps the link.
    await conns.reconnectConnection({ workspaceId: WS_B }, inB.id, {
      type: "github_app",
      installation_id: "111",
      app_id: "123",
      access_token: "ghs_refreshed",
    });
    expect(
      (await db.appConnection.findUniqueOrThrow({ where: { id: inB.id } }))
        .sourceConnectionId,
    ).toBe(original.id);

    // A real re-auth (the OAuth callback sends metadata) stores its own key:
    // it is no longer built on the source, so removing the source spares it.
    await conns.reconnectConnection(
      { workspaceId: WS_B },
      inB.id,
      {
        type: "github_app",
        installation_id: "111",
        app_id: "123",
        private_key: privateKey,
        access_token: "ghs_own",
      },
      { metadata: { username: "acme", installationId: "111" } },
    );
    expect(
      (await db.appConnection.findUniqueOrThrow({ where: { id: inB.id } }))
        .sourceConnectionId,
    ).toBeNull();
    await conns.deleteConnection({ workspaceId: WS_A }, original.id);
    expect(await db.appConnection.count({ where: { id: inB.id } })).toBe(1);
  });

  it("removing a shared connection leaves the original alone", async () => {
    const original = await seedOriginal({ organizationId: ORG }, "111", "acme");
    mockGitHub();
    const inB = await share.createSharedConnection({
      caller: caller({ workspaceId: WS_B }),
      sourceConnectionId: original.id,
      repositories: ["acme/web"],
    });
    await conns.deleteConnection({ workspaceId: WS_B }, inB.id);
    expect(await db.appConnection.count({ where: { id: original.id } })).toBe(
      1,
    );
  });

  it("promote moves a workspace connection to the org in place", async () => {
    const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
    const moved = await conns.promoteConnectionToOrganization(
      WS_A,
      ORG,
      original.id,
    );
    expect(moved.id).toBe(original.id);
    const row = await db.appConnection.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(row).toMatchObject({
      scope: "organization",
      organizationId: ORG,
      workspaceId: null,
    });
    // Now offered to every workspace as an org-level installation.
    const forB = await share.listSharedInstallations(
      caller({
        workspaceId: WS_B,
      }),
    );
    expect(forB[0]?.origin).toBe("organization");
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
    expect(
      (await db.appConnection.findUniqueOrThrow({ where: { id: foreign.id } }))
        .scope,
    ).toBe("workspace");
  });

  it("promote refuses a shared connection", async () => {
    const original = await seedOriginal({ workspaceId: WS_A }, "111", "acme");
    mockGitHub();
    const inB = await share.createSharedConnection({
      caller: caller({ workspaceId: WS_B }),
      sourceConnectionId: original.id,
      repositories: ["acme/web"],
    });
    await expect(
      conns.promoteConnectionToOrganization(WS_B, ORG, inB.id),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    expect(
      (await db.appConnection.findUniqueOrThrow({ where: { id: inB.id } }))
        .scope,
    ).toBe("workspace");
  });
});
