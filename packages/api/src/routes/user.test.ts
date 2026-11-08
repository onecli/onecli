import { describe, expect, it, vi } from "vitest";

// The identity routes' auth posture: GET /user must work without a workspace
// header — `onecli auth login` verifies keys through it, and an ORG key
// carries no workspace of its own (the regression read every org key as
// invalid). The api-key sub-routes stay workspace-scoped via requireWorkspaceId.
//
// Deliberately NOT pinning an edition: this runs under CI's cloud edition
// (CAPS.rbac on) — the edition the bug lived in and where `onecli auth login`
// with an org key matters. That means org-key auth performs the admin
// role re-check (api-key.ts), so the test registers a roleResolver, exactly
// as the real cloud stack does. Without it the org key would 401 at the role
// gate — masking whether the requireWorkspace fix works at all.

const ORG_KEY = "oc_org_test-key";

const services = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({
    email: "admin@example.com",
    name: "Admin",
  })),
  sshKeyRows: [] as Array<{ id: string; userId: string }>,
  auditCreate: vi.fn(async () => ({})),
  regenerateApiKey: vi.fn(async () => ({ apiKey: "oc_rotated_value" })),
}));

vi.mock("@onecli/db", () => ({
  // A class so the ssh-key-service's `instanceof` duplicate check is callable
  // (never taken here — the in-memory create below cannot throw P2002).
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
      findFirst: async () => null,
    },
    user: { findUnique: async () => ({ email: "admin@example.com" }) },
    userSshKey: {
      findMany: async () => services.sshKeyRows,
      count: async () => services.sshKeyRows.length,
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        services.sshKeyRows.find(
          (r) => r.id === where.id && r.userId === where.userId,
        ) ?? null,
      create: async ({ data }: { data: { userId: string; name: string } }) => {
        const row = {
          id: "key-1",
          ...data,
          fingerprint: "SHA256:x",
          createdAt: new Date(),
          lastUsedAt: null,
        };
        services.sshKeyRows.push(row as never);
        return row;
      },
      deleteMany: async ({
        where,
      }: {
        where: { id: string; userId: string };
      }) => {
        const before = services.sshKeyRows.length;
        services.sshKeyRows = services.sshKeyRows.filter(
          (r) => !(r.id === where.id && r.userId === where.userId),
        );
        return { count: before - services.sshKeyRows.length };
      },
    },
    // The audit writes are best-effort by contract; give them a real sink so
    // the handlers stay on the happy path.
    auditLog: { create: services.auditCreate },
    // The org key's workspace header resolves only for its own org's "ws-1".
    workspace: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === "ws-1" ? { id: "ws-1" } : null,
    },
  },
}));

vi.mock("../services/api-key-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/api-key-service")>()),
  regenerateApiKey: services.regenerateApiKey,
}));

vi.mock("../services/user-service", () => ({
  getUser: services.getUser,
  updateProfile: vi.fn(),
}));

const { createApiApp } = await import("../app");

const app = createApiApp(
  { getSession: async () => null },
  // The key's user still holds an admin role — the cloud org-key gate.
  { roleResolver: { getUserRole: async () => "owner" } },
);

const AUTH = { Authorization: `Bearer ${ORG_KEY}` };

describe("GET /v1/user auth posture", () => {
  it("answers an org key WITHOUT a workspace header (the auth login path)", async () => {
    const res = await app.request("/v1/user", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: "admin@example.com" });
  });

  it("keeps the workspace-scoped api-key sub-route fenced for org keys", async () => {
    const res = await app.request("/v1/user/api-key", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("X-Workspace-Id");
  });

  it("still rejects an unknown key outright", async () => {
    const res = await app.request("/v1/user", {
      headers: { Authorization: "Bearer oc_org_nope" },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/user/api-key/regenerate", () => {
  // The dashboard's API Key page and the CLI share this one door, so the
  // route itself leaves the audit trail of the rotation.
  it("rotates the caller's key in the named workspace and audits it, never the key", async () => {
    services.auditCreate.mockClear();
    services.regenerateApiKey.mockClear();
    const res = await app.request("/v1/user/api-key/regenerate", {
      method: "POST",
      headers: { ...AUTH, "X-Workspace-Id": "ws-1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ apiKey: "oc_rotated_value" });
    expect(services.regenerateApiKey).toHaveBeenCalledWith("user-1", {
      workspaceId: "ws-1",
    });
    expect(services.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          userId: "user-1",
          action: "regenerate",
          service: "api-key",
          source: "api",
        }),
      }),
    );
    expect(JSON.stringify(services.auditCreate.mock.calls)).not.toContain(
      "oc_rotated_value",
    );
  });

  it("rotates nothing and audits nothing without a workspace", async () => {
    services.auditCreate.mockClear();
    services.regenerateApiKey.mockClear();
    const res = await app.request("/v1/user/api-key/regenerate", {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(services.regenerateApiKey).not.toHaveBeenCalled();
    expect(services.auditCreate).not.toHaveBeenCalled();
  });
});

describe("/v1/user/ssh-keys (account-level, no workspace fence)", () => {
  const post = (body: unknown) =>
    app.request("/v1/user/ssh-keys", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lists without a workspace header", async () => {
    const res = await app.request("/v1/user/ssh-keys", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sshKeys: [] });
  });

  it("registers a valid ed25519 key with 201", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { formatEd25519PublicKeyLine, spkiToEd25519Raw } =
      await import("@onecli/ssh-cert");
    const pair = generateKeyPairSync("ed25519");
    const line = formatEd25519PublicKeyLine(
      spkiToEd25519Raw(
        Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })),
      ),
      "route-test",
    );
    const res = await post({ name: "MacBook", publicKey: line });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sshKey: { id: string } };
    expect(body.sshKey.id).toBe("key-1");

    const del = await app.request(`/v1/user/ssh-keys/${body.sshKey.id}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(del.status).toBe(204);
  });

  it("refuses a malformed body with the documented 422 shape", async () => {
    const res = await post({ name: "", publicKey: "x" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBeTruthy();
  });

  it("refuses a non-ed25519 key with 422", async () => {
    const res = await post({ name: "RSA", publicKey: "ssh-rsa AAAAB3Nza" });
    expect(res.status).toBe(422);
  });

  it("404s a delete of an id the user does not own", async () => {
    const res = await app.request("/v1/user/ssh-keys/not-mine", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });
});
