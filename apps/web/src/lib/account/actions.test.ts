import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSession: async () => ({ id: "ext-1" }),
}));
vi.mock("@onecli/api/ee/sso/sso-enforcement", () => ({
  enforceSsoSession: async () => null,
}));
vi.mock("@onecli/api/services/organization-service", () => ({
  activeMembershipWhere: {},
}));
vi.mock("@onecli/api/ee/billing/plans", () => ({
  normalizePlan: (plan: string) => plan,
  getPlanConfig: () => ({ limits: { auditLogDays: 30 } }),
}));
vi.mock("@onecli/db", () => ({
  db: {
    user: {
      findUnique: async () => ({
        id: "u1",
        email: "owner@example.test",
        name: "Owner",
      }),
    },
    organizationMember: {
      findMany: async () => [{ organization: { subscriptionStatus: "free" } }],
    },
    auditLog: {
      findMany: async () => state.rows,
    },
  },
}));

import { getAuditLogs } from "./actions";

const row = (over: Record<string, unknown>) => ({
  id: "log-1",
  workspaceId: "ws-1",
  action: "sandbox.home_growth",
  service: "sandbox",
  status: "success",
  source: "api",
  userEmail: "owner@example.test",
  actorKind: "user",
  serviceActor: null,
  metadata: {},
  createdAt: new Date("2026-10-01T00:00:00Z"),
  workspace: { name: "Workspace" },
  organization: { name: "Org" },
  ...over,
});

beforeEach(() => {
  state.rows = [];
});

describe("getAuditLogs: the service-row fence", () => {
  it("a `user` row carries the actor's email; a `service` row (a platform service's own action, attributed to the org owner only to anchor the FK) carries NO email and names the service actor; an unknown actorKind is a service row (fail closed)", async () => {
    state.rows = [
      row({ id: "log-user" }),
      row({
        id: "log-service",
        actorKind: "service",
        serviceActor: "scim-provisioner",
      }),
      row({
        id: "log-odd",
        actorKind: "robot",
        serviceActor: "something",
      }),
    ];
    const logs = await getAuditLogs();
    expect(
      logs.map((l) => [l.id, l.actorKind, l.userEmail, l.serviceActor]),
    ).toEqual([
      ["log-user", "user", "owner@example.test", null],
      ["log-service", "service", "", "scim-provisioner"],
      ["log-odd", "service", "", "something"],
    ]);
    // The owner's email never reaches the client on a service row, under
    // any key.
    expect(JSON.stringify(logs.slice(1))).not.toContain("owner@example.test");
  });
});
