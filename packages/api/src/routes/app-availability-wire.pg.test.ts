import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The availability provider is registered only on the cloud edition, and
// edition reads freeze at module load, so the pin runs before every import.
vi.hoisted(() => {
  process.env.EDITION = "cloud";
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * GET /v1/apps/available on real PostgreSQL, through `createApiApp` with a
 * signed-in org owner: the connect picker's allowlist for a workspace.
 *
 * In a "restricted" org a workspace may connect the providers of every rule
 * that names one of its inherited people: its WorkspaceAccess users, the
 * members of its granted groups (active org members only), and the groups to
 * match (granted directly, plus every group those users belong to). Every arm
 * is fenced to the org, so each planted control below names a principal that
 * must NOT count, with a provider of its own that must never appear.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;

const P = "availwire-";
const ORG = `${P}org`;
const FOREIGN_ORG = `${P}foreign-org`;
const WORKSPACE = `${P}ws`;
/** A workspace of the same org with no access rows: nobody to inherit. */
const EMPTY_WORKSPACE = `${P}empty-ws`;
const SELF_URL = "https://api.availwire.test";

/** The caller: org owner with a direct WorkspaceAccess row. */
const OWNER = `${P}owner`;
/** Inherited through the granted group. */
const VIA_GROUP = `${P}via-group`;
/** A direct WorkspaceAccess user whose membership is suspended. */
const SUSPENDED = `${P}suspended`;
/** A member of the granted group with no membership in the org. */
const OUTSIDER = `${P}outsider`;
/** A member of the granted group who is active only in ANOTHER org. */
const FOREIGN_MEMBER = `${P}foreign-member`;
/** An active org member reachable only through a foreign group's grant. */
const VIA_FOREIGN_GRANT = `${P}via-foreign-grant`;
/** An active org member with no path to the workspace at all. */
const UNRELATED = `${P}unrelated`;
const USERS = [
  OWNER,
  VIA_GROUP,
  SUSPENDED,
  OUTSIDER,
  FOREIGN_MEMBER,
  VIA_FOREIGN_GRANT,
  UNRELATED,
];

/** Granted to the workspace. */
const GRANTED_GROUP = `${P}granted-group`;
/** Granted to the workspace, with no members: counts as a grant alone. */
const EMPTY_GRANTED_GROUP = `${P}empty-granted-group`;
/** Not granted, but VIA_GROUP belongs to it. */
const MEMBER_GROUP = `${P}member-group`;
/** Another org's group, granted to the workspace by a stray cross-org row. */
const FOREIGN_GRANTED_GROUP = `${P}foreign-granted-group`;
/** Another org's group that VIA_GROUP also belongs to. */
const FOREIGN_MEMBER_GROUP = `${P}foreign-member-group`;
const GROUPS = [
  GRANTED_GROUP,
  EMPTY_GRANTED_GROUP,
  MEMBER_GROUP,
  FOREIGN_GRANTED_GROUP,
  FOREIGN_MEMBER_GROUP,
];

let currentSession: { id: string; email: string } | null = null;

const available = async (workspaceId: string) => {
  const res = await app.request("/v1/apps/available", {
    headers: { "x-workspace-id": workspaceId },
  });
  const body = (await res.json()) as {
    restricted: boolean;
    providers: string[];
  };
  return {
    status: res.status,
    restricted: body.restricted,
    providers: [...body.providers].sort(),
  };
};

const setMode = (mode: "open" | "restricted") =>
  db.organization.update({
    where: { id: ORG },
    data: { appAvailabilityMode: mode },
  });

const rule = (
  organizationId: string,
  providers: string[],
  identity: { userId: string } | { groupId: string },
) =>
  db.appAvailabilityRule.create({
    data: {
      organizationId,
      providers,
      identities: { create: [identity] },
    },
  });

const cleanup = async () => {
  const orgs = [ORG, FOREIGN_ORG];
  await db.appAvailabilityRule.deleteMany({
    where: { organizationId: { in: orgs } },
  });
  await db.workspaceAccess.deleteMany({
    where: { workspaceId: { in: [WORKSPACE, EMPTY_WORKSPACE] } },
  });
  await db.groupMember.deleteMany({ where: { groupId: { in: GROUPS } } });
  await db.group.deleteMany({ where: { id: { in: GROUPS } } });
  await db.organizationMember.deleteMany({
    where: { organizationId: { in: orgs } },
  });
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, EMPTY_WORKSPACE] } },
  });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: USERS } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ db } = await import("@onecli/db"));
  const { createApiApp } = await import("../app");
  app = createApiApp(
    { getSession: async () => currentSession },
    { selfUrl: SELF_URL },
  );

  await cleanup();
  for (const id of [ORG, FOREIGN_ORG]) {
    await db.organization.create({ data: { id, name: id, slug: id } });
  }
  for (const id of [WORKSPACE, EMPTY_WORKSPACE]) {
    await db.workspace.create({ data: { id, name: id, organizationId: ORG } });
  }
  for (const id of USERS) {
    await db.user.create({
      data: { id, email: `${id}@example.com`, externalAuthId: id, name: id },
    });
  }
  const member = (
    userId: string,
    role: string,
    status: "active" | "suspended" = "active",
    organizationId = ORG,
  ) =>
    db.organizationMember.create({
      data: {
        organizationId,
        userId,
        userEmail: `${userId}@example.com`,
        role,
        status,
      },
    });
  await member(OWNER, "owner");
  await member(VIA_GROUP, "member");
  await member(SUSPENDED, "member", "suspended");
  await member(VIA_FOREIGN_GRANT, "member");
  await member(UNRELATED, "member");
  await member(FOREIGN_MEMBER, "member", "active", FOREIGN_ORG);

  for (const id of [GRANTED_GROUP, EMPTY_GRANTED_GROUP, MEMBER_GROUP]) {
    await db.group.create({ data: { id, organizationId: ORG, name: id } });
  }
  for (const id of [FOREIGN_GRANTED_GROUP, FOREIGN_MEMBER_GROUP]) {
    await db.group.create({
      data: { id, organizationId: FOREIGN_ORG, name: id },
    });
  }
  await db.groupMember.createMany({
    data: [
      { groupId: GRANTED_GROUP, userId: VIA_GROUP },
      { groupId: GRANTED_GROUP, userId: OUTSIDER },
      { groupId: GRANTED_GROUP, userId: FOREIGN_MEMBER },
      { groupId: MEMBER_GROUP, userId: VIA_GROUP },
      { groupId: FOREIGN_MEMBER_GROUP, userId: VIA_GROUP },
      { groupId: FOREIGN_GRANTED_GROUP, userId: VIA_FOREIGN_GRANT },
    ],
  });
  await db.workspaceAccess.createMany({
    data: [
      { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
      { workspaceId: WORKSPACE, userId: SUSPENDED },
      { workspaceId: WORKSPACE, groupId: GRANTED_GROUP },
      { workspaceId: WORKSPACE, groupId: EMPTY_GRANTED_GROUP },
      { workspaceId: WORKSPACE, groupId: FOREIGN_GRANTED_GROUP },
    ],
  });

  currentSession = { id: OWNER, email: `${OWNER}@example.com` };
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await cleanup();
});

describe.skipIf(!PROOF_URL)(
  "GET /v1/apps/available: the workspace's app allowlist",
  () => {
    it("is unrestricted while the org is open", async () => {
      await setMode("open");
      expect(await available(WORKSPACE)).toEqual({
        status: 200,
        restricted: false,
        providers: [],
      });
    });

    it("is restricted to nothing when no rule names an inherited person", async () => {
      await setMode("restricted");
      expect(await available(WORKSPACE)).toEqual({
        status: 200,
        restricted: true,
        providers: [],
      });
    });

    it("unions the rules naming inherited people and groups, fenced to the org", async () => {
      await setMode("restricted");
      // Each provider below names exactly one arm.
      await rule(ORG, ["airtable"], { userId: OWNER });
      await rule(ORG, ["slack", "gmail"], { userId: VIA_GROUP });
      await rule(ORG, ["github"], { groupId: GRANTED_GROUP });
      await rule(ORG, ["linear"], { groupId: MEMBER_GROUP });
      await rule(ORG, ["jira"], { groupId: EMPTY_GRANTED_GROUP });
      // Planted controls: none of these may reach the workspace.
      await rule(ORG, ["notion"], { userId: SUSPENDED });
      await rule(ORG, ["asana"], { userId: OUTSIDER });
      await rule(ORG, ["figma"], { userId: FOREIGN_MEMBER });
      await rule(ORG, ["dropbox"], { groupId: FOREIGN_GRANTED_GROUP });
      await rule(ORG, ["todoist"], { userId: VIA_FOREIGN_GRANT });
      await rule(ORG, ["x"], { groupId: FOREIGN_MEMBER_GROUP });
      await rule(ORG, ["fathom"], { userId: UNRELATED });
      await rule(FOREIGN_ORG, ["hubspot"], { userId: OWNER });

      expect(await available(WORKSPACE)).toEqual({
        status: 200,
        restricted: true,
        providers: ["airtable", "github", "gmail", "jira", "linear", "slack"],
      });
    });

    it("is restricted to nothing for a workspace with no access rows", async () => {
      await setMode("restricted");
      expect(await available(EMPTY_WORKSPACE)).toEqual({
        status: 200,
        restricted: true,
        providers: [],
      });
    });
  },
);
