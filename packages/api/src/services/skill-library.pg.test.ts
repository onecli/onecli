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

/**
 * The skill library on REAL PostgreSQL. GitHub's
 * HTTP API is the only stub: a small in-memory repo served through `fetch`.
 *
 * Proves: connect verifies the branch; discover lists the repo live and marks
 * what an agent holds; attach stores ONE skill's files at the head commit and
 * reaches only that agent's projection; library wins a same-name clash in the
 * composer; detaching the last holder deletes the stored skill; the refresh
 * pass moves stored skills to a new head and keeps the last version when the
 * skill disappears upstream; the agent tools list library skills and refuse
 * writes; and every door is fenced to the caller's org and workspace.
 *
 *   POLICY_PROOF_DATABASE_URL=postgresql://… pnpm --filter @onecli/api test -- \
 *     --run src/services/skill-library.pg.test.ts
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Lib = typeof import("./skill-library-service");
type Sync = typeof import("./home-sync-service");
type Conn = typeof import("./connection-service");
type Skills = typeof import("./skill-service");

let db: Db;
let lib: Lib;
let sync: Sync;
let conns: Conn;
let skills: Skills;
let grants: typeof import("./skill-library-grant");

const P = "sklib-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WS = `${P}ws`;
const WS_OTHER = `${P}ws-other`;
const REPO = "acme/claude-skills";
/** A second repo the same installation reaches (a switch target). */
const OTHER_REPO = "acme/other";
/** The runner the test sandboxes sit on (a sandbox needs one). */
const RUNNER = `${P}runner`;

let privateKey = "";
let connectionId = "";
let otherConnectionId = "";

// ── A fake GitHub repo ──────────────────────────────────────────────────────

const repo = {
  head: "c1",
  files: new Map<string, string>(),
  /** When set, the recursive listing says it was truncated. */
  truncated: false,
};
const setRepo = (head: string, files: Record<string, string>) => {
  repo.head = head;
  repo.files = new Map(Object.entries(files));
  repo.truncated = false;
};
const blobSha = (path: string) =>
  `${repo.head}:${Buffer.from(path).toString("hex")}`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** The fake repo's tree at `prefix` (a folder, or "" for the root), as
 * GitHub answers: recursive lists every blob below, non-recursive lists
 * the direct children (subfolders as `tree` entries). */
const treeAt = (prefix: string, recursive: boolean) => {
  const below = [...repo.files.entries()]
    .filter(([path]) => prefix === "" || path.startsWith(`${prefix}/`))
    .map(([path, content]) => ({
      path: prefix === "" ? path : path.slice(prefix.length + 1),
      content,
    }));
  if (recursive) {
    return below.map(({ path, content }) => ({
      path,
      type: "blob",
      mode: "100644",
      sha: blobSha(prefix === "" ? path : `${prefix}/${path}`),
      size: Buffer.byteLength(content),
    }));
  }
  const children = new Map<string, { type: string; sha: string }>();
  for (const { path } of below) {
    const [first, ...rest] = path.split("/");
    if (!first) continue;
    const full = prefix === "" ? first : `${prefix}/${first}`;
    children.set(first, {
      type: rest.length > 0 ? "tree" : "blob",
      sha: rest.length > 0 ? `tree:${full}` : blobSha(full),
    });
  }
  return [...children.entries()].map(([path, e]) => ({
    path,
    mode: e.type === "tree" ? "040000" : "100644",
    ...e,
  }));
};

/** Every GitHub request the stub served, for asserting what was minted. */
const ghCalls: { url: string; body: string | null }[] = [];
/** What GitHub answers a token mint with: 201, or a refusal status. */
const mint = { status: 201 };

const stubGitHub = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      ghCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (url.includes("/access_tokens")) {
        if (mint.status !== 201) {
          return json({ message: "refused" }, mint.status);
        }
        return json(
          {
            token: "ghs_test",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: { contents: "read" },
          },
          201,
        );
      }
      if (url.includes("/installation/repositories")) {
        return json({
          total_count: 2,
          repositories: [{ full_name: REPO }, { full_name: "acme/other" }],
        });
      }
      if (url.includes(`/repos/acme/`) && url.includes(`/commits/`)) {
        // Two branches: `main`, and `release` (one commit behind).
        return url.endsWith("/commits/main")
          ? json({ sha: repo.head })
          : url.endsWith("/commits/release")
            ? json({ sha: `${repo.head}-release` })
            : json({ message: "No commit found" }, 404);
      }
      if (url.includes(`/repos/acme/`) && url.includes(`/git/trees/`)) {
        const [sha, query] = (url.split("/git/trees/")[1] ?? "").split("?");
        const ref = decodeURIComponent(sha ?? "");
        const recursive = query === "recursive=1";
        const prefix = ref.startsWith("tree:") ? ref.slice(5) : "";
        if (prefix === "" && recursive && repo.truncated) {
          // GitHub's truncated recursive listing: only top-level entries.
          return json({ truncated: true, tree: treeAt("", false) });
        }
        return json({ truncated: false, tree: treeAt(prefix, recursive) });
      }
      if (url.includes(`/repos/acme/`) && url.includes(`/git/blobs/`)) {
        const sha = decodeURIComponent(url.split("/git/blobs/")[1] ?? "");
        const hex = sha.split(":")[1] ?? "";
        const path = Buffer.from(hex, "hex").toString();
        const content = repo.files.get(path);
        return content === undefined
          ? json({ message: "Not Found" }, 404)
          : json({
              encoding: "base64",
              content: Buffer.from(content).toString("base64"),
            });
      }
      return json({ message: "Not Found" }, 404);
    }),
  );

const SNOWFLAKE_MD =
  "---\nname: snowflake\ndescription: Use when querying Snowflake\n---\nRUN SQL\n";

const baseRepo = () =>
  setRepo("c1", {
    ".claude-plugin/marketplace.json": "{}",
    "plugins/data-tools/skills/snowflake/SKILL.md": SNOWFLAKE_MD,
    "plugins/data-tools/skills/snowflake/references/tables.md": "TABLES v1",
    "plugins/data-tools/skills/dbt/SKILL.md":
      "---\nname: dbt\ndescription: How dbt works\n---\nDBT\n",
    "plugins/eng/skills/broken/SKILL.md":
      "---\nname: not-broken\ndescription: x\n---\n",
  });

// ── Seeding ─────────────────────────────────────────────────────────────────

const seedConnection = (
  scope: { organizationId: string },
  installationId: string,
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
        username: "acme",
        accountType: "Organization",
        installationId,
        repositorySelection: "all",
      },
    },
  );

let agentSeq = 0;
const seedAgent = async (workspaceId = WS, kind = "hosted") => {
  agentSeq += 1;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `agent ${agentSeq}`,
      identifier: `${P}a${agentSeq}`,
      accessToken: `aoc_${P}${agentSeq}_${randomBytes(4).toString("hex")}`,
      kind,
      ...(kind === "hosted" && { harness: "fake" }),
    },
    select: { id: true },
  });
  return agent.id;
};

const attach = (agentId: string, name: string, workspaceId = WS) =>
  lib.attachLibrarySkill({
    organizationId: ORG,
    workspaceId,
    agentId,
    name,
    userId: null,
  });

const homePaths = async (agentId: string) =>
  (await sync.buildHomeFileSet(agentId)).map((f) => f.path);

/** A running sandbox for `agentId`, to observe home-sync bumps. */
const seedSandbox = async (agentId: string) =>
  (
    await db.sandbox.create({
      data: {
        agentId,
        runnerId: RUNNER,
        status: "running",
        homeDesiredGeneration: 1,
      },
      select: { id: true },
    })
  ).id;

/** A sandbox's desired home generation (each bump adds one). */
const generationOf = async (sandboxId: string) =>
  (
    await db.sandbox.findUniqueOrThrow({
      where: { id: sandboxId },
      select: { homeDesiredGeneration: true },
    })
  ).homeDesiredGeneration;

const reset = async () => {
  await db.skillSource.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.skill.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.appConnection.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.workspace.deleteMany({ where: { id: { in: [WS, WS_OTHER] } } });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await db.runner.deleteMany({ where: { id: RUNNER } });
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

  // The org's GitHub App (env tier): a skills-only grant mints with it.
  Object.assign(process.env, {
    GITHUB_APP_ID: "123",
    GITHUB_APP_SLUG: "onecli-test",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    // Its OAuth client: GitHub proves a user's access to an installation
    // (without it a skills-only install is refused).
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_CLIENT_SECRET: "test-secret",
  });

  ({ db } = await import("@onecli/db"));
  const { ensureEditionDefaults } = await import("../edition-defaults");
  ensureEditionDefaults();
  lib = await import("./skill-library-service");
  grants = await import("./skill-library-grant");
  sync = await import("./home-sync-service");
  conns = await import("./connection-service");
  skills = await import("./skill-service");

  await reset();
  await db.organization.createMany({
    data: [
      { id: ORG, name: ORG, slug: ORG },
      { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
    ],
  });
  await db.workspace.createMany({
    data: [
      { id: WS, name: "WS", organizationId: ORG },
      { id: WS_OTHER, name: "Other", organizationId: OTHER_ORG },
    ],
  });
  connectionId = (await seedConnection({ organizationId: ORG }, "111")).id;
  otherConnectionId = (
    await seedConnection({ organizationId: OTHER_ORG }, "222")
  ).id;
  await db.runner.create({
    data: { id: RUNNER, name: "library", token: `rnr_${P}runner` },
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  ghCalls.length = 0;
  mint.status = 201;
  if (!PROOF_URL) return;
  await db.skillSource.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.skill.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
});

afterAll(async () => {
  for (const k of [
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
  ])
    delete process.env[k];
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

const connect = () =>
  lib.connectSkillSource(
    ORG,
    { appConnectionId: connectionId, repo: REPO, branch: "main" },
    { userId: null, email: null },
  );

describe.skipIf(!PROOF_URL)("the skill library", () => {
  it("connect verifies the branch, and a foreign org's connection is refused", async () => {
    baseRepo();
    stubGitHub();
    await expect(
      lib.connectSkillSource(
        ORG,
        { appConnectionId: connectionId, repo: REPO, branch: "nope" },
        { userId: null, email: null },
      ),
    ).rejects.toThrow(/Couldn't find/);
    await expect(
      lib.connectSkillSource(
        ORG,
        { appConnectionId: otherConnectionId, repo: REPO },
        { userId: null, email: null },
      ),
    ).rejects.toThrow(/GitHub connection/);

    const source = await connect();
    expect(source).toMatchObject({ repo: REPO, branch: "main", headSha: "c1" });
    expect((await lib.getSkillSource(OTHER_ORG)).source).toBeNull();
    // Every token the library minted reads contents only, for this one repo.
    const mints = ghCalls.filter((c) => c.url.includes("/access_tokens"));
    expect(mints.length).toBeGreaterThan(0);
    for (const mint of mints) {
      expect(JSON.parse(mint.body ?? "{}")).toMatchObject({
        permissions: { contents: "read" },
      });
    }
  });

  it("discover lists the repo live, with standard problems and the plugin", async () => {
    baseRepo();
    stubGitHub();
    await connect();
    const listing = await lib.discoverLibrarySkills(ORG);
    const byName = Object.fromEntries(listing.skills.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual([
      "dbt",
      "not-broken",
      "snowflake",
    ]);
    expect(byName.snowflake).toMatchObject({
      plugin: "data-tools",
      problem: null,
      fileCount: 2,
    });
    expect(byName["not-broken"]?.problem).toMatch(/doesn't match its folder/);
    // Nothing stored by browsing.
    expect(
      await db.librarySkill.count({
        where: { source: { organizationId: ORG } },
      }),
    ).toBe(0);
  });

  it("attach stores one skill at the head and reaches only that agent", async () => {
    baseRepo();
    stubGitHub();
    await connect();
    const a1 = await seedAgent();
    const a2 = await seedAgent();
    const stored = await attach(a1, "snowflake");
    expect(stored).toMatchObject({ commitSha: "c1", fileCount: 2 });

    expect(await homePaths(a1)).toEqual(
      expect.arrayContaining([
        ".agents/skills/snowflake/SKILL.md",
        ".agents/skills/snowflake/references/tables.md",
      ]),
    );
    expect((await homePaths(a2)).some((p) => p.includes("/snowflake/"))).toBe(
      false,
    );
    const listing = await lib.discoverLibrarySkills(ORG, a1);
    expect(listing.skills.find((s) => s.name === "snowflake")?.added).toBe(
      true,
    );
    expect(listing.skills.find((s) => s.name === "dbt")?.added).toBe(false);

    // An invalid skill can't be attached.
    await expect(attach(a1, "not-broken")).rejects.toThrow(/folder/);
  });

  it("library wins a same-name clash with the agent's own skill", async () => {
    baseRepo();
    stubGitHub();
    await connect();
    const a1 = await seedAgent();
    await skills.createSkill(
      WS,
      {
        name: "snowflake",
        description: "mine",
        content: "MY COPY",
        agentId: a1,
      },
      { userId: null, email: null },
    );
    await attach(a1, "snowflake");
    const md = (await sync.buildHomeFileSet(a1)).find(
      (f) => f.path === ".agents/skills/snowflake/SKILL.md",
    );
    expect(md?.content).toBe(SNOWFLAKE_MD);
  });

  it("each agent's switch: off leaves its home and tools, other agents keep it; removing the last holder deletes the stored skill", async () => {
    baseRepo();
    stubGitHub();
    await connect();
    const a1 = await seedAgent();
    const a2 = await seedAgent();
    await attach(a1, "dbt");
    await attach(a2, "dbt");

    const off = await lib.setAgentLibrarySkillEnabled({
      organizationId: ORG,
      workspaceId: WS,
      agentId: a1,
      name: "dbt",
      enabled: false,
    });
    expect(off.enabled).toBe(false);
    expect((await homePaths(a1)).some((p) => p.includes("/dbt/"))).toBe(false);
    expect(await lib.libraryNamesForAgent(a1, ORG)).toEqual([]);
    // Still listed on a1's page, switched off; a2 untouched.
    expect(
      (await lib.listLibrarySkillsForAgent(ORG, a1)).map((s) => [
        s.name,
        s.enabled,
      ]),
    ).toEqual([["dbt", false]]);
    expect(await homePaths(a2)).toContain(".agents/skills/dbt/SKILL.md");

    // Adding again switches it back on.
    await attach(a1, "dbt");
    expect(await homePaths(a1)).toContain(".agents/skills/dbt/SKILL.md");

    // A skill the agent doesn't hold can't be switched.
    await expect(
      lib.setAgentLibrarySkillEnabled({
        organizationId: ORG,
        workspaceId: WS,
        agentId: a1,
        name: "snowflake",
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    for (const agentId of [a1, a2]) {
      await lib.detachLibrarySkill({
        organizationId: ORG,
        workspaceId: WS,
        agentId,
        name: "dbt",
      });
    }
    expect(await db.librarySkill.count({ where: { name: "dbt" } })).toBe(0);
  });

  it("refresh moves stored skills to the new head; a removed skill keeps its last version", async () => {
    baseRepo();
    stubGitHub();
    const source = await connect();
    const a1 = await seedAgent();
    await attach(a1, "snowflake");
    await attach(a1, "dbt");

    setRepo("c2", {
      "plugins/data-tools/skills/snowflake/SKILL.md": SNOWFLAKE_MD,
      "plugins/data-tools/skills/snowflake/references/tables.md": "TABLES v2",
    });
    await lib.refreshSkillSource(source.id);

    const tables = (await sync.buildHomeFileSet(a1)).find(
      (f) => f.path === ".agents/skills/snowflake/references/tables.md",
    );
    expect(tables?.content).toBe("TABLES v2");
    const dbt = await db.librarySkill.findFirstOrThrow({
      where: { name: "dbt", source: { organizationId: ORG } },
    });
    expect(dbt.commitSha).toBe("c1");
    expect(dbt.lastError).toMatch(/Removed from the repo/);
    expect(await homePaths(a1)).toContain(".agents/skills/dbt/SKILL.md");
    expect((await lib.getSkillSource(ORG)).source?.headSha).toBe("c2");
  });

  it("status reads behind once the repo moves, and Re-sync brings it current", async () => {
    baseRepo();
    stubGitHub();
    const source = await connect();
    const a1 = await seedAgent();
    await attach(a1, "snowflake");
    const view = async () =>
      (await lib.listLibrarySkillsForAgent(ORG, a1)).find(
        (s) => s.name === "snowflake",
      );
    expect((await view())?.status).toBe("current");

    // The repo moves; a background check notices but this skill isn't
    // refetched yet (simulated by recording the head only).
    setRepo("c3", {
      "plugins/data-tools/skills/snowflake/SKILL.md": SNOWFLAKE_MD,
      "plugins/data-tools/skills/snowflake/references/tables.md": "TABLES v3",
    });
    await db.skillSource.update({
      where: { id: source.id },
      data: { headSha: "c3" },
    });
    expect(await view()).toMatchObject({
      status: "behind",
      commitSha: "c1",
      repoSha: "c3",
    });

    const fresh = await lib.resyncLibrarySkill(ORG, "snowflake");
    expect(fresh).toMatchObject({ status: "current", commitSha: "c3" });
    const tables = (await sync.buildHomeFileSet(a1)).find(
      (f) => f.path === ".agents/skills/snowflake/references/tables.md",
    );
    expect(tables?.content).toBe("TABLES v3");

    // Removed upstream: Re-sync keeps the last version and says why.
    setRepo("c4", { "README.md": "empty" });
    const kept = await lib.resyncLibrarySkill(ORG, "snowflake");
    expect(kept).toMatchObject({ status: "error", commitSha: "c3" });
    expect(kept.lastError).toMatch(/Removed from the repo/);
  });

  it("the library owns its GitHub credential: removing the original connection does not break it", async () => {
    baseRepo();
    stubGitHub();
    // A workspace's own GitHub install can't back the org library.
    const wsConn = await conns.createConnection(
      { workspaceId: WS },
      "github-app",
      {
        type: "github_app",
        installation_id: "333",
        app_id: "123",
        private_key: privateKey,
        access_token: "ghs_seed",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
      { metadata: { username: "acme-ws", installationId: "333" } },
    );
    await expect(
      lib.connectSkillSource(
        ORG,
        { appConnectionId: wsConn.id, repo: REPO },
        { userId: null, email: null },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // An org connection, which the library copies.
    const orgConn = await seedConnection({ organizationId: ORG }, "333");
    const source = await lib.connectSkillSource(
      ORG,
      { appConnectionId: orgConn.id, repo: REPO },
      { userId: null, email: null },
    );
    expect(source).toMatchObject({
      account: "acme",
      installationId: "333",
      appConnectionId: orgConn.id,
    });
    const a1 = await seedAgent();
    await attach(a1, "snowflake");

    // The org disconnects its GitHub.
    await db.appConnection.delete({ where: { id: orgConn.id } });

    const { source: after } = await lib.getSkillSource(ORG);
    expect(after).toMatchObject({ appConnectionId: null, repo: REPO });
    // Still reads the repo, still serves the agent, still re-syncs.
    expect((await lib.discoverLibrarySkills(ORG)).skills.length).toBe(3);
    expect(await homePaths(a1)).toContain(".agents/skills/snowflake/SKILL.md");
    expect((await lib.resyncLibrarySkill(ORG, "snowflake")).status).toBe(
      "current",
    );
    // The stored credential is encrypted, never the plain signing key.
    const raw = await db.skillSource.findUniqueOrThrow({
      where: { organizationId: ORG },
      select: { credentials: true },
    });
    expect(raw.credentials).not.toContain("PRIVATE KEY");
  });

  it("add, switch and remove are fenced: a foreign workspace's agent and a BYO agent are refused", async () => {
    baseRepo();
    stubGitHub();
    await connect();
    const foreign = await seedAgent(WS_OTHER);
    await expect(attach(foreign, "snowflake")).rejects.toThrow(
      /Agent not found/,
    );
    const byo = await seedAgent(WS, "byo");
    await expect(attach(byo, "snowflake")).rejects.toThrow(/hosted/);

    // A real holder in this workspace; a foreign workspace naming it (or
    // its own agent) can neither switch nor remove the skill.
    const mine = await seedAgent();
    await attach(mine, "snowflake");
    for (const [workspaceId, agentId] of [
      [WS_OTHER, mine],
      [WS, foreign],
    ] as const) {
      await expect(
        lib.setAgentLibrarySkillEnabled({
          organizationId: ORG,
          workspaceId,
          agentId,
          name: "snowflake",
          enabled: false,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        lib.detachLibrarySkill({
          organizationId: ORG,
          workspaceId,
          agentId,
          name: "snowflake",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await homePaths(mine)).toContain(
      ".agents/skills/snowflake/SKILL.md",
    );
    // The other org has no library at all.
    await expect(lib.discoverLibrarySkills(OTHER_ORG)).rejects.toThrow(
      /No skill library/,
    );
  });

  it("disconnect removes every library skill from agents", async () => {
    baseRepo();
    stubGitHub();
    await connect();
    const a1 = await seedAgent();
    await attach(a1, "snowflake");
    await lib.disconnectSkillSource(ORG);
    expect((await homePaths(a1)).some((p) => p.includes("/snowflake/"))).toBe(
      false,
    );
    expect(
      await db.librarySkill.count({
        where: { source: { organizationId: ORG } },
      }),
    ).toBe(0);
  });

  it("offers only the org's OWN org-level GitHub accounts for reuse", async () => {
    // A workspace install of this org, and the seeded org-level ones.
    const wsConn = await conns.createConnection(
      { workspaceId: WS },
      "github-app",
      {
        type: "github_app",
        installation_id: "999",
        app_id: "123",
        private_key: privateKey,
      },
      { metadata: { username: "ws-acct", installationId: "999" } },
    );
    try {
      const mine = await lib.listLibraryGitHubAccounts(ORG);
      expect(mine.map((a) => a.appConnectionId)).toEqual([connectionId]);
      expect(mine[0]).toMatchObject({ installationId: "111", account: "acme" });
      const theirs = await lib.listLibraryGitHubAccounts(OTHER_ORG);
      expect(theirs.map((a) => a.appConnectionId)).toEqual([otherConnectionId]);
    } finally {
      await db.appConnection.delete({ where: { id: wsConn.id } });
    }
  });

  describe("Install GitHub for skills only (no org connection)", () => {
    const USER = `${P}admin`;
    const grantFor = (
      over: {
        organizationId?: string;
        userId?: string;
        installationId?: string;
      } = {},
    ) =>
      grants.signLibraryGrant({
        organizationId: over.organizationId ?? ORG,
        userId: over.userId ?? USER,
        grant: {
          installationId: over.installationId ?? "333",
          account: "acme",
          accountType: "Organization",
        },
      });
    const connectWith = (grant: string, userId: string | null = USER) =>
      lib.connectSkillSource(
        ORG,
        { grant, repo: REPO, branch: "main" },
        { userId, email: null },
      );
    const ghConnections = () =>
      db.appConnection.count({
        where: { provider: "github-app", organizationId: ORG },
      });

    it("connects the library from a grant, with no connection created", async () => {
      baseRepo();
      stubGitHub();
      const before = await ghConnections();

      const listed = await lib.listLibraryAccessRepos(ORG, USER, {
        grant: grantFor(),
      });
      expect(listed.repos).toContain(REPO);

      const source = await connectWith(grantFor());
      expect(source).toMatchObject({
        repo: REPO,
        installationId: "333",
        account: "acme",
        appConnectionId: null,
      });
      expect(await ghConnections()).toBe(before);
      // It works on its own access.
      expect(
        (await lib.discoverLibrarySkills(ORG)).skills.length,
      ).toBeGreaterThan(0);
    });

    it("refuses a grant for another org, another user, or with no signed-in user", async () => {
      baseRepo();
      stubGitHub();
      for (const [grant, userId] of [
        [grantFor({ organizationId: OTHER_ORG }), USER],
        [grantFor({ userId: `${P}someone-else` }), USER],
        [grantFor(), null],
      ] as const) {
        await expect(connectWith(grant, userId)).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
      }
      expect((await lib.getSkillSource(ORG)).source).toBeNull();
    });

    it("refuses a tampered grant, an expired one, and an OAuth state posing as one", async () => {
      baseRepo();
      stubGitHub();
      const decoded = JSON.parse(
        Buffer.from(grantFor(), "base64url").toString(),
      );
      decoded.data.installationId = "999";
      const forged = Buffer.from(JSON.stringify(decoded)).toString("base64url");
      await expect(connectWith(forged)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      const { signOAuthState, generateNonce } =
        await import("../lib/oauth-state");
      const state = signOAuthState({
        provider: "github-app",
        nonce: generateNonce(),
        organizationId: ORG,
        userId: USER,
        installationId: "333",
        expiresAt: Date.now() + 60_000,
      });
      await expect(connectWith(state)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      const grant = grantFor();
      vi.useFakeTimers({ now: Date.now() + 11 * 60 * 1000 });
      try {
        await expect(connectWith(grant)).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
      } finally {
        vi.useRealTimers();
      }
      expect((await lib.getSkillSource(ORG)).source).toBeNull();
    });

    it("changing the repo later keeps the library's own access (no connection, no new install)", async () => {
      baseRepo();
      stubGitHub();
      await connectWith(grantFor());
      const listed = await lib.listLibraryAccessRepos(ORG, USER, {});
      expect(listed.repos).toEqual([REPO, "acme/other"]);
      const again = await lib.connectSkillSource(
        ORG,
        { repo: REPO, branch: "main" },
        { userId: USER, email: null },
      );
      expect(again).toMatchObject({
        installationId: "333",
        appConnectionId: null,
      });
    });

    it("with no library yet, neither a connection nor a grant is a 400", async () => {
      stubGitHub();
      await expect(
        lib.connectSkillSource(
          ORG,
          { repo: REPO },
          { userId: USER, email: null },
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("an existing org connection still works and is recorded as the source", async () => {
      baseRepo();
      stubGitHub();
      const source = await connect();
      expect(source.appConnectionId).toBe(connectionId);
    });
  });

  describe("hardening", () => {
    it("two folders claiming one name are both refused, each naming the other", async () => {
      setRepo("c1", {
        "plugins/a/skills/review/SKILL.md":
          "---\nname: review\ndescription: A's review\n---\nA\n",
        "plugins/z/skills/review/SKILL.md":
          "---\nname: review\ndescription: Z's review\n---\nZ\n",
      });
      stubGitHub();
      await connect();
      const listing = await lib.discoverLibrarySkills(ORG);
      expect(
        listing.skills.map((s) => [s.path, s.problem, s.conflicts]),
      ).toEqual([
        [
          "plugins/a/skills/review",
          "Name used twice in the repo",
          ["plugins/z/skills/review"],
        ],
        [
          "plugins/z/skills/review",
          "Name used twice in the repo",
          ["plugins/a/skills/review"],
        ],
      ]);
      await expect(attach(await seedAgent(), "review")).rejects.toThrow(
        /Name used twice/,
      );
    });

    it("a stored skill that becomes a duplicate keeps its last version and says why", async () => {
      baseRepo();
      stubGitHub();
      const source = await connect();
      const a1 = await seedAgent();
      await attach(a1, "dbt");
      setRepo("c2", {
        "plugins/data-tools/skills/dbt/SKILL.md":
          "---\nname: dbt\ndescription: v2\n---\nDBT v2\n",
        "plugins/other/skills/dbt/SKILL.md":
          "---\nname: dbt\ndescription: impostor\n---\nNOT OURS\n",
      });
      await lib.refreshSkillSource(source.id);
      const row = await db.librarySkill.findFirstOrThrow({
        where: { name: "dbt", source: { organizationId: ORG } },
      });
      expect(row).toMatchObject({
        commitSha: "c1",
        path: "plugins/data-tools/skills/dbt",
      });
      expect(row.lastError).toMatch(/Name used twice/);
      const md = (await sync.buildHomeFileSet(a1)).find(
        (f) => f.path === ".agents/skills/dbt/SKILL.md",
      );
      expect(md?.content).toContain("DBT\n");
      expect(md?.content).not.toContain("NOT OURS");
    });

    it("a file too large to deliver is refused at add, never dropped silently at sync", async () => {
      // ~110 KB of quotes: under the 120 KB download cap, but JSON escaping
      // doubles it past the 200 KB sync frame.
      const big = `---\nname: big\ndescription: Escapes a lot\n---\n${'"'.repeat(110_000)}`;
      setRepo("c1", {
        "skills/big/SKILL.md": big,
        "skills/ok/SKILL.md": "---\nname: ok\ndescription: Fine\n---\nOK\n",
        "skills/ok/references/huge.md": '"'.repeat(110_000),
      });
      stubGitHub();
      await connect();
      const listing = await lib.discoverLibrarySkills(ORG);
      expect(listing.skills.find((s) => s.name === "big")?.problem).toMatch(
        /too large to deliver/,
      );
      const a1 = await seedAgent();
      await expect(attach(a1, "big")).rejects.toThrow(/too large to deliver/);
      // A supporting file too large to deliver is skipped and listed.
      const ok = await attach(a1, "ok");
      expect(ok.skipped).toEqual([
        {
          path: "references/huge.md",
          reason: "Too large to deliver to an agent",
        },
      ]);
      expect(await homePaths(a1)).toContain(".agents/skills/ok/SKILL.md");
    });

    it("an add stops at the cap, and adding a skill the agent holds still works at the cap", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < lib.MAX_LIBRARY_SKILLS_PER_AGENT + 1; i += 1) {
        const name = `s${i}`;
        files[`skills/${name}/SKILL.md`] =
          `---\nname: ${name}\ndescription: d\n---\nx\n`;
      }
      setRepo("c1", files);
      stubGitHub();
      await connect();
      const a1 = await seedAgent();
      await Promise.all(
        Array.from({ length: lib.MAX_LIBRARY_SKILLS_PER_AGENT }, (_, i) =>
          attach(a1, `s${i}`),
        ),
      );
      expect(await db.agentLibrarySkill.count({ where: { agentId: a1 } })).toBe(
        lib.MAX_LIBRARY_SKILLS_PER_AGENT,
      );
      await expect(
        attach(a1, `s${lib.MAX_LIBRARY_SKILLS_PER_AGENT}`),
      ).rejects.toThrow(/already has/);
      await lib.setAgentLibrarySkillEnabled({
        organizationId: ORG,
        workspaceId: WS,
        agentId: a1,
        name: "s0",
        enabled: false,
      });
      // Re-adding a held skill switches it back on, cap or not.
      expect((await attach(a1, "s0")).enabled).toBe(true);
    });

    it("parallel adds can't take an agent past the cap", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < lib.MAX_LIBRARY_SKILLS_PER_AGENT + 5; i += 1) {
        files[`skills/p${i}/SKILL.md`] =
          `---\nname: p${i}\ndescription: d\n---\nx\n`;
      }
      setRepo("c1", files);
      stubGitHub();
      await connect();
      const a1 = await seedAgent();
      const results = await Promise.allSettled(
        Array.from({ length: lib.MAX_LIBRARY_SKILLS_PER_AGENT + 5 }, (_, i) =>
          attach(a1, `p${i}`),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(
        lib.MAX_LIBRARY_SKILLS_PER_AGENT,
      );
      expect(await db.agentLibrarySkill.count({ where: { agentId: a1 } })).toBe(
        lib.MAX_LIBRARY_SKILLS_PER_AGENT,
      );
    });

    // Long file names make a skill's share of the sync budget large: each
    // costs ~170 bytes of manifest, so `filesFor(share)` files take about
    // `share` of LIBRARY_MANIFEST_BUDGET_BYTES.
    const long = (i: number) => `references/${"r".repeat(120)}${i}.md`;
    const filesFor = (share: number) =>
      Math.ceil((sync.LIBRARY_MANIFEST_BUDGET_BYTES * share) / 170);

    it("an agent's library stays inside its sync budget", async () => {
      const files: Record<string, string> = {};
      for (let s = 0; s < 3; s += 1) {
        files[`skills/w${s}/SKILL.md`] =
          `---\nname: w${s}\ndescription: d\n---\nx\n`;
        for (let f = 0; f < filesFor(0.4); f += 1) {
          files[`skills/w${s}/${long(f)}`] = "x";
        }
      }
      setRepo("c1", files);
      stubGitHub();
      await connect();
      const a1 = await seedAgent();
      await attach(a1, "w0");
      await attach(a1, "w1");
      await expect(attach(a1, "w2")).rejects.toThrow(/too big to deliver/);
      expect(
        (await lib.listLibrarySkillsForAgent(ORG, a1)).map((s) => s.name),
      ).toEqual(["w0", "w1"]);
    });

    it("a refresh that would push a holder over budget keeps the last version", async () => {
      const files: Record<string, string> = {
        "skills/grow/SKILL.md": "---\nname: grow\ndescription: d\n---\nv1\n",
        "skills/fat/SKILL.md": "---\nname: fat\ndescription: d\n---\nx\n",
      };
      for (let f = 0; f < filesFor(0.6); f += 1) {
        files[`skills/fat/${long(f)}`] = "x";
      }
      setRepo("c1", files);
      stubGitHub();
      const source = await connect();
      const a1 = await seedAgent();
      await attach(a1, "fat");
      await attach(a1, "grow");
      const grown = { ...files };
      grown["skills/grow/SKILL.md"] =
        "---\nname: grow\ndescription: d\n---\nv2\n";
      for (let f = 0; f < filesFor(0.6); f += 1) {
        grown[`skills/grow/${long(f)}`] = "x";
      }
      setRepo("c2", grown);
      await lib.refreshSkillSource(source.id);
      const row = await db.librarySkill.findFirstOrThrow({
        where: { name: "grow", source: { organizationId: ORG } },
      });
      expect(row.commitSha).toBe("c1");
      expect(row.lastError).toMatch(/too big to deliver/);
    });

    it("an add still in flight for the old repo writes nothing once the repo is switched", async () => {
      baseRepo();
      stubGitHub();
      await connect();
      const holder = await seedAgent();
      await attach(holder, "dbt");
      const a1 = await seedAgent();
      // Hold the add's file download until the switch has landed.
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      let held = false;
      const served = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        async (input: string | URL, init?: RequestInit) => {
          if (String(input).includes("/git/blobs/") && !held) {
            held = true;
            await gate;
          }
          return served(input, init);
        },
      );
      const pending = attach(a1, "snowflake");
      await vi.waitFor(() => expect(held).toBe(true));
      // A confirmed switch to another repo lands while that add waits.
      const switched = await lib.connectSkillSource(
        ORG,
        { appConnectionId: connectionId, repo: OTHER_REPO, replace: true },
        { userId: null, email: null },
      );
      release();
      await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
      // Nothing from the old repo landed on the new source.
      expect(
        await db.librarySkill.count({ where: { sourceId: switched.id } }),
      ).toBe(0);
    });

    it("switching the repo or the branch replaces the source: needs confirmation, then starts clean", async () => {
      baseRepo();
      stubGitHub();
      const first = await connect();
      const a1 = await seedAgent();
      await attach(a1, "snowflake");
      // Same repo + branch with new access keeps everything.
      const same = await connect();
      expect(same.id).toBe(first.id);
      expect(await homePaths(a1)).toContain(
        ".agents/skills/snowflake/SKILL.md",
      );

      for (const target of [
        { repo: OTHER_REPO, branch: "main" },
        { repo: REPO, branch: "release" },
      ]) {
        await expect(
          lib.connectSkillSource(
            ORG,
            { appConnectionId: connectionId, ...target },
            { userId: null, email: null },
          ),
        ).rejects.toMatchObject({
          usage: { skillNames: ["snowflake"], agentCount: 1 },
        });
      }
      const sandbox = await seedSandbox(a1);
      const switched = await lib.connectSkillSource(
        ORG,
        {
          appConnectionId: connectionId,
          repo: REPO,
          branch: "release",
          replace: true,
        },
        { userId: null, email: null },
      );
      expect(switched).toMatchObject({
        branch: "release",
        headSha: "c1-release",
      });
      expect(switched.id).not.toBe(first.id);
      // Starts clean, and the holder was woken to drop the skill.
      expect(await homePaths(a1)).not.toContain(
        ".agents/skills/snowflake/SKILL.md",
      );
      expect(await generationOf(sandbox)).toBe(2);
    });

    it("a fixed upstream problem clears when the branch is back to the stored commit", async () => {
      baseRepo();
      stubGitHub();
      const source = await connect();
      const a1 = await seedAgent();
      await attach(a1, "dbt");
      setRepo("c2", { "README.md": "dbt removed" });
      await lib.refreshSkillSource(source.id);
      expect((await lib.listLibrarySkillsForAgent(ORG, a1))[0]?.status).toBe(
        "error",
      );
      baseRepo(); // the branch rolls back to c1
      await lib.refreshSkillSource(source.id);
      expect((await lib.listLibrarySkillsForAgent(ORG, a1))[0]).toMatchObject({
        status: "current",
        lastError: null,
      });
    });

    it("a truncated repo listing still refreshes a stored skill through its own folder, whole", async () => {
      baseRepo();
      stubGitHub();
      const source = await connect();
      const a1 = await seedAgent();
      await attach(a1, "snowflake");
      setRepo("c2", {
        "plugins/data-tools/skills/snowflake/SKILL.md": SNOWFLAKE_MD,
        "plugins/data-tools/skills/snowflake/references/tables.md": "TABLES v2",
      });
      // GitHub truncates the recursive listing: the skill isn't in it.
      repo.truncated = true;
      await lib.refreshSkillSource(source.id);
      const row = await db.librarySkill.findFirstOrThrow({
        where: { name: "snowflake", source: { organizationId: ORG } },
        include: { files: true },
      });
      // Not marked removed, and moved forward with every file.
      expect(row).toMatchObject({ commitSha: "c2", lastError: null });
      expect(
        Object.fromEntries(row.files.map((f) => [f.path, f.content])),
      ).toEqual({
        "SKILL.md": SNOWFLAKE_MD,
        "references/tables.md": "TABLES v2",
      });
    });

    it("a file whose home path the sync wire can't carry is left out with a reason", async () => {
      // Four legal segments (depth and segment length both allowed), yet
      // 540 characters as a home path: over the wire's 512.
      const deep = `${"a".repeat(128)}/${"b".repeat(128)}/${"c".repeat(128)}/${"d".repeat(125)}.md`;
      setRepo("c1", {
        "plugins/data-tools/skills/snowflake/SKILL.md": SNOWFLAKE_MD,
        [`plugins/data-tools/skills/snowflake/${deep}`]: "too far down",
      });
      stubGitHub();
      await connect();
      const a1 = await seedAgent();
      const stored = await attach(a1, "snowflake");
      expect(stored.skipped).toEqual([{ path: deep, reason: "Path too long" }]);
      const paths = await homePaths(a1);
      expect(paths).toContain(".agents/skills/snowflake/SKILL.md");
      expect(paths.every((p) => p.length <= 512)).toBe(true);
    });

    it("a library skill the composer refuses never hides the agent's own copy", async () => {
      baseRepo();
      stubGitHub();
      await connect();
      const a1 = await seedAgent();
      await skills.createSkill(
        WS,
        {
          name: "snowflake",
          description: "mine",
          content: "MY COPY",
          agentId: a1,
        },
        { userId: null, email: null },
      );
      const stored = await attach(a1, "snowflake");
      // Bypass every belt: a stored path the wire could never carry.
      await db.librarySkillFile.create({
        data: { librarySkillId: stored.id, path: "../../evil", content: "x" },
      });
      const md = (await sync.buildHomeFileSet(a1)).find(
        (f) => f.path === ".agents/skills/snowflake/SKILL.md",
      );
      expect(md?.content).toContain("MY COPY");
    });

    it("two first connects at once both land, as one source", async () => {
      baseRepo();
      stubGitHub();
      const [a, b] = await Promise.all([connect(), connect()]);
      expect(a.id).toBe(b.id);
      expect(
        await db.skillSource.count({ where: { organizationId: ORG } }),
      ).toBe(1);
    });

    it("a deleted agent's skills leave the switch impact, and the refresh stops fetching them", async () => {
      baseRepo();
      stubGitHub();
      const source = await connect();
      const gone = await seedAgent();
      const kept = await seedAgent();
      await attach(gone, "snowflake");
      await attach(kept, "dbt");
      await db.agent.delete({ where: { id: gone } });

      const { usage } = await lib.getSkillSource(ORG);
      expect(usage).toEqual({ skillNames: ["dbt"], agentCount: 1 });
      setRepo("c2", {
        "plugins/data-tools/skills/dbt/SKILL.md":
          "---\nname: dbt\ndescription: How dbt works\n---\nDBT v2\n",
        "plugins/data-tools/skills/snowflake/SKILL.md": SNOWFLAKE_MD,
      });
      ghCalls.length = 0;
      await lib.refreshSkillSource(source.id);
      expect(
        (
          await db.librarySkill.findMany({
            where: { sourceId: source.id },
            select: { name: true },
          })
        ).map((s) => s.name),
      ).toEqual(["dbt"]);
      // No blob of the orphan was read.
      const snowflakeBlob = Buffer.from(
        "plugins/data-tools/skills/snowflake/references",
      ).toString("hex");
      expect(ghCalls.some((c) => c.url.includes(snowflakeBlob))).toBe(false);
    });

    it("a refresh wakes only the agents holding a skill that changed", async () => {
      baseRepo();
      stubGitHub();
      const source = await connect();
      const holdsDbt = await seedAgent();
      const holdsSnowflake = await seedAgent();
      const holdsNothing = await seedAgent();
      await attach(holdsDbt, "dbt");
      await attach(holdsSnowflake, "snowflake");
      const [sbDbt, sbSnow, sbNone] = await Promise.all(
        [holdsDbt, holdsSnowflake, holdsNothing].map(seedSandbox),
      );
      if (!sbDbt || !sbSnow || !sbNone) throw new Error("not seeded");
      // Only dbt changes in c2.
      setRepo("c2", {
        ...Object.fromEntries(repo.files),
        "plugins/data-tools/skills/dbt/SKILL.md":
          "---\nname: dbt\ndescription: How dbt works\n---\nDBT v2\n",
      });
      await lib.refreshSkillSource(source.id);
      expect(await generationOf(sbDbt)).toBe(2);
      // Snowflake moved to c2 with the same files: its home is unchanged...
      expect(await generationOf(sbSnow)).toBe(1);
      // ...and an agent with no library skill is never recomposed.
      expect(await generationOf(sbNone)).toBe(1);
    });

    it("a skill whose folder moved in the repo follows it", async () => {
      baseRepo();
      stubGitHub();
      const source = await connect();
      const a1 = await seedAgent();
      await attach(a1, "snowflake");
      setRepo("c2", {
        "skills/snowflake/SKILL.md": SNOWFLAKE_MD,
        "skills/snowflake/references/tables.md": "TABLES moved",
      });
      await lib.refreshSkillSource(source.id);
      const [row] = await lib.listLibrarySkillsForAgent(ORG, a1);
      expect(row).toMatchObject({
        path: "skills/snowflake",
        commitSha: "c2",
        status: "current",
        lastError: null,
      });
      const listing = await lib.discoverLibrarySkills(ORG, a1);
      expect(listing.skills.find((s) => s.name === "snowflake")?.added).toBe(
        true,
      );
    });

    it("two first adds of one skill to two agents both land, on one stored copy", async () => {
      baseRepo();
      stubGitHub();
      await connect();
      const a1 = await seedAgent();
      const a2 = await seedAgent();
      const [r1, r2] = await Promise.all([
        attach(a1, "snowflake"),
        attach(a2, "snowflake"),
      ]);
      expect(r1.id).toBe(r2.id);
      expect(
        await db.librarySkill.count({
          where: { name: "snowflake", source: { organizationId: ORG } },
        }),
      ).toBe(1);
      expect(
        await db.agentLibrarySkill.count({ where: { librarySkillId: r1.id } }),
      ).toBe(2);
    });

    it("the refresh claim: due sources once each across concurrent sweeps, fresh ones never", async () => {
      baseRepo();
      stubGitHub();
      const source = await connect();
      // connect stamped the clock now: not due.
      expect(await lib.refreshDueSkillSources()).toBe(0);
      await db.skillSource.update({
        where: { id: source.id },
        data: { lastCheckedAt: new Date(Date.now() - 600_000) },
      });
      const claims = await Promise.all([
        lib.refreshDueSkillSources(),
        lib.refreshDueSkillSources(),
      ]);
      expect(claims.sort()).toEqual([0, 1]);
      expect(await lib.refreshDueSkillSources()).toBe(0);
    });

    it("an agent's library is held to its file budget, not just its manifest", async () => {
      // Few files, escape-heavy content: the manifest is tiny, the frames
      // are not. 26 files of 19,000 control characters fit the 500 KB raw
      // cap, and each serializes to ~114 KB (6 bytes per character), so a
      // skill costs ~2.97 MB of frames: four fit the 12 MB budget.
      const files: Record<string, string> = {};
      const body = "\u0001".repeat(19_000);
      for (let s = 0; s < 5; s += 1) {
        files[`skills/b${s}/SKILL.md`] =
          `---\nname: b${s}\ndescription: d\n---\nx\n`;
        for (let f = 0; f < 26; f += 1) files[`skills/b${s}/f${f}.md`] = body;
      }
      setRepo("c1", files);
      stubGitHub();
      await connect();
      const a1 = await seedAgent();
      for (const name of ["b0", "b1", "b2", "b3"]) {
        expect((await attach(a1, name)).skipped).toEqual([]);
      }
      await expect(attach(a1, "b4")).rejects.toThrow(/too big to deliver/);
      expect(sync.LIBRARY_SYNC_BUDGET_BYTES).toBe(12_000_000);
    });

    it("lost access is flagged for a reconnect; a GitHub outage is not", async () => {
      baseRepo();
      stubGitHub();
      const source = await connect();
      const flags = async () =>
        (await lib.getSkillSource(ORG)).source?.accessLost;

      mint.status = 503; // GitHub having a bad minute
      await lib.refreshSkillSource(source.id);
      expect(await flags()).toBe(false);
      expect((await lib.getSkillSource(ORG)).source?.lastError).toMatch(
        /Couldn't reach GitHub/,
      );

      mint.status = 404; // the app was removed from the account
      await lib.refreshSkillSource(source.id);
      expect(await flags()).toBe(true);

      mint.status = 201; // reconnected
      await connect();
      expect(await flags()).toBe(false);
    });
  });
});
