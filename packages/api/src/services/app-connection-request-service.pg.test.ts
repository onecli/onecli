import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@onecli/db";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * `request_app_connection` on REAL PostgreSQL: the account probe that picks
 * "attach" over "connect" is fenced to the calling agent's workspace and its
 * organization's shared pool. The planted negative controls: a foreign
 * workspace's account and a foreign organization's shared account of the same
 * app must both read as "nothing connected", never as "attach" (which would
 * confirm another tenant holds the app), and so must an account of this
 * workspace that is disconnected or waiting on a reconnect (switching it on
 * would not help). Env-gated like the other proof suites; see
 * load-rules.pg.test.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let service: typeof import("./app-connection-request-service");

const P = "acrq-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WORKSPACE = `${P}ws`;
const OTHER_WORKSPACE = `${P}other-ws`;
const FOREIGN_WORKSPACE = `${P}foreign-ws`;
const AGENT = `${P}agent`;
const AGENT_NAME = "Donna's Bot";
const ME = { agentId: AGENT, workspaceId: WORKSPACE, organizationId: ORG };

const reset = async () => {
  await db.appConnection.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  service = await import("./app-connection-request-service");
  await reset();

  for (const id of [ORG, OTHER_ORG]) {
    await db.organization.create({ data: { id, name: id, slug: id } });
  }
  for (const [id, organizationId] of [
    [WORKSPACE, ORG],
    [OTHER_WORKSPACE, ORG],
    [FOREIGN_WORKSPACE, OTHER_ORG],
  ] as const) {
    await db.workspace.create({ data: { id, name: id, organizationId } });
  }
  await db.agent.create({
    data: {
      id: AGENT,
      workspaceId: WORKSPACE,
      name: AGENT_NAME,
      identifier: AGENT,
      accessToken: `aoc_${AGENT}`,
    },
  });
  const conn = (
    id: string,
    data: Omit<Prisma.AppConnectionUncheckedCreateInput, "id">,
  ) => db.appConnection.create({ data: { id, status: "connected", ...data } });
  // Planted: the same apps held by OTHER tenants only.
  await conn(`${P}jira-other-ws`, {
    provider: "jira",
    scope: "workspace",
    workspaceId: OTHER_WORKSPACE,
  });
  await conn(`${P}jira-foreign-org`, {
    provider: "jira",
    scope: "organization",
    organizationId: OTHER_ORG,
  });
  // A sibling workspace's account, scoped to the workspace, is not shared.
  // This org's SHARED confluence account is.
  await conn(`${P}confluence-org`, {
    provider: "confluence",
    scope: "organization",
    organizationId: ORG,
  });
  // A disconnected account in this workspace is not an attach target.
  await conn(`${P}gmail-dead`, {
    provider: "gmail",
    scope: "workspace",
    workspaceId: WORKSPACE,
    status: "disconnected",
  });
  // Nor is one the provider refused to refresh: only a reconnect revives it.
  await conn(`${P}notion-reauth`, {
    provider: "notion",
    scope: "workspace",
    workspaceId: WORKSPACE,
    reauthRequiredAt: new Date(),
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)("requestAppConnection (pg)", () => {
  it("another workspace's and another org's accounts read as nothing connected", async () => {
    const res = await service.requestAppConnection(ME, "jira");
    expect(res.status).toBe("connect");
    expect(JSON.stringify(res)).not.toContain(P + "jira");
  });

  it("this organization's shared account is an attach target", async () => {
    const res = await service.requestAppConnection(ME, "confluence");
    expect(res.status).toBe("attach");
    if (res.status !== "attach") throw new Error("expected attach");
    expect(res.manageUrl).toContain(
      `/w/${WORKSPACE}/agents/${AGENT}/connections?attach=confluence`,
    );
  });

  it("a disconnected account is not an attach target", async () => {
    const res = await service.requestAppConnection(ME, "gmail");
    expect(res.status).toBe("connect");
  });

  it("an account waiting on a reconnect is not an attach target", async () => {
    const res = await service.requestAppConnection(ME, "notion");
    expect(res.status).toBe("connect");
  });

  it("the connect link names this agent the way the gateway does", async () => {
    const res = await service.requestAppConnection(ME, "jira");
    if (res.status !== "connect") throw new Error("expected connect");
    expect(res.connectUrl).toContain(
      `/w/${WORKSPACE}/connections?connect=jira&source=agent&agent_name=Donna%27s%20Bot&agent_id=acrq%2Dagent`,
    );
  });
});
