import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// Route-level authz matrix for the directory's human-group surface: admin
// gate on every route, enterprise gate ("groups") on writes only, SCIM-lock
// conflicts surfacing as 409, and the §3.5 envelope statuses — over a
// mocked service layer.

const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const store = vi.hoisted(() => ({
  members: [] as { organizationId: string; userId: string; role: string }[],
  featureAllowed: true,
  scimLocked: false,
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
      // withAudit's built-in gateway flush enumerates org keys.
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ email: "admin@example.com" }),
    },
    organizationMember: {
      findUnique: async ({
        where,
      }: {
        where: {
          organizationId_userId: { organizationId: string; userId: string };
        };
      }) => {
        const { organizationId, userId } = where.organizationId_userId;
        return (
          store.members.find(
            (m) => m.organizationId === organizationId && m.userId === userId,
          ) ?? null
        );
      },
    },
    auditLog: { create: async () => ({}) },
  },
}));

vi.mock("../services/quota-service", () => ({
  assertFeatureAllowed: async () => {
    if (!store.featureAllowed) {
      const { ServiceError } = await import("../../services/errors");
      throw new ServiceError("FORBIDDEN", "Requires the Enterprise plan");
    }
  },
}));

const serviceCalls = vi.hoisted(() => ({
  list: 0,
  create: 0,
  setMembers: 0,
  addMember: 0,
  removeMember: 0,
}));

const groupRow = {
  id: "grp-1",
  name: "HR",
  source: "manual",
  externalId: null,
  memberCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

vi.mock("../services/group-service", () => ({
  listGroups: async () => {
    serviceCalls.list += 1;
    return { data: [groupRow], nextCursor: null };
  },
  getGroup: async () => groupRow,
  createGroup: async () => {
    serviceCalls.create += 1;
    return groupRow;
  },
  renameGroup: async () => {
    if (store.scimLocked) {
      const { ServiceError } = await import("../../services/errors");
      throw new ServiceError(
        "CONFLICT",
        "This group is managed by your identity provider.",
      );
    }
    return groupRow;
  },
  deleteGroup: async () => ({ id: "grp-1", name: "HR" }),
  listGroupMembers: async () => ({ data: [], nextCursor: null }),
  addGroupMember: async () => {
    serviceCalls.addMember += 1;
    return { added: true };
  },
  removeGroupMember: async () => {
    serviceCalls.removeMember += 1;
    return { removed: true };
  },
  setGroupMembers: async () => {
    serviceCalls.setMembers += 1;
    return { added: 2, removed: 1 };
  },
}));

import { createApiApp } from "../../app";
import { getUserRole } from "../services/authorization-service";
import { orgGroupRoutes } from "./org-groups";

const nullSession = { getSession: async () => null };

let app: Hono<ApiEnv>;
beforeAll(() => {
  app = createApiApp(nullSession, {
    roleResolver: { getUserRole },
    eeRoutes: (a) => {
      a.route("/org/groups", orgGroupRoutes());
    },
  });
});

const authed = { headers: { Authorization: `Bearer ${ORG_KEY}` } };

beforeEach(() => {
  store.members = [
    { organizationId: "org-1", userId: "user-1", role: "admin" },
  ];
  store.featureAllowed = true;
  store.scimLocked = false;
  serviceCalls.list = 0;
  serviceCalls.create = 0;
  serviceCalls.setMembers = 0;
  serviceCalls.addMember = 0;
  serviceCalls.removeMember = 0;
});

describe("GET /v1/org/groups", () => {
  it("lists (enveloped) for admins without the feature gate", async () => {
    store.featureAllowed = false; // gate must not apply to reads
    const res = await app.request("/v1/org/groups", authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [expect.objectContaining({ id: "grp-1", memberCount: 0 })],
      nextCursor: null,
    });
    expect(serviceCalls.list).toBe(1);
  });

  it("rejects an org key whose user is below admin (the demotion re-check)", async () => {
    store.members = [
      { organizationId: "org-1", userId: "user-1", role: "member" },
    ];
    const res = await app.request("/v1/org/groups", authed);
    expect(res.status).toBe(401);
  });

  it("401s without credentials", async () => {
    const res = await app.request("/v1/org/groups");
    expect(res.status).toBe(401);
  });

  it("400s on an out-of-range limit", async () => {
    const res = await app.request("/v1/org/groups?limit=9999", authed);
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/org/groups", () => {
  const body = JSON.stringify({ name: "HR" });

  it("creates for enterprise admins", async () => {
    const res = await app.request("/v1/org/groups", {
      ...authed,
      method: "POST",
      body,
    });
    expect(res.status).toBe(201);
    expect(serviceCalls.create).toBe(1);
  });

  it("403s when the plan lacks the groups feature", async () => {
    store.featureAllowed = false;
    const res = await app.request("/v1/org/groups", {
      ...authed,
      method: "POST",
      body,
    });
    expect(res.status).toBe(403);
    expect(serviceCalls.create).toBe(0);
  });

  it("400s on invalid bodies", async () => {
    const res = await app.request("/v1/org/groups", {
      ...authed,
      method: "POST",
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("SCIM-managed lock", () => {
  it("PATCH surfaces the service CONFLICT as 409", async () => {
    store.scimLocked = true;
    const res = await app.request("/v1/org/groups/grp-1", {
      ...authed,
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("membership sub-resource", () => {
  it("bulk PUT returns the diff and is feature-gated", async () => {
    const res = await app.request("/v1/org/groups/grp-1/members", {
      ...authed,
      method: "PUT",
      body: JSON.stringify({ userIds: ["u1", "u2"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 2, removed: 1 });

    store.featureAllowed = false;
    const gated = await app.request("/v1/org/groups/grp-1/members", {
      ...authed,
      method: "PUT",
      body: JSON.stringify({ userIds: [] }),
    });
    expect(gated.status).toBe(403);
    expect(serviceCalls.setMembers).toBe(1);
  });

  it("add-one and remove-one return 204", async () => {
    const put = await app.request("/v1/org/groups/grp-1/members/u1", {
      ...authed,
      method: "PUT",
    });
    expect(put.status).toBe(204);
    expect(serviceCalls.addMember).toBe(1);

    const del = await app.request("/v1/org/groups/grp-1/members/u1", {
      ...authed,
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    expect(serviceCalls.removeMember).toBe(1);
  });

  it("DELETE group is gated", async () => {
    store.featureAllowed = false;
    const res = await app.request("/v1/org/groups/grp-1", {
      ...authed,
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});
