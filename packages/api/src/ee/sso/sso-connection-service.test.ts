import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.COGNITO_USER_POOL_ID = "us-east-1_test";
  process.env.COGNITO_CLIENT_ID = "client-test";
});

const store = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  seq: 0,
  ssoRequired: false,
}));

vi.mock("@onecli/db", () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  const matches = (
    row: Record<string, unknown>,
    where: Record<string, unknown>,
  ) => Object.entries(where).every(([k, v]) => row[k] === v);
  // Honor Prisma's `select` — the service relies on it for redaction.
  const workspace = (
    row: Record<string, unknown> | null,
    select?: Record<string, boolean>,
  ) => {
    if (!row || !select) return row;
    return Object.fromEntries(
      Object.keys(select)
        .filter((k) => select[k])
        .map((k) => [k, row[k]]),
    );
  };
  return {
    Prisma: { PrismaClientKnownRequestError },
    db: {
      organizationSsoConnection: {
        findFirst: async ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select?: Record<string, boolean>;
        }) =>
          workspace(store.rows.find((r) => matches(r, where)) ?? null, select),
        findUnique: async ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select?: Record<string, boolean>;
        }) =>
          workspace(store.rows.find((r) => matches(r, where)) ?? null, select),
        findMany: async ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select?: Record<string, boolean>;
        }) =>
          store.rows
            .filter((r) => matches(r, where))
            .map((r) => workspace(r, select)),
        create: async ({
          data,
          select,
        }: {
          data: Record<string, unknown>;
          select?: Record<string, boolean>;
        }) => {
          if (
            store.rows.some(
              (r) => r.cognitoProviderName === data.cognitoProviderName,
            )
          ) {
            throw new PrismaClientKnownRequestError("P2002");
          }
          const row = {
            id: `conn-${++store.seq}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          };
          store.rows.push(row);
          return workspace(row, select);
        },
        update: async ({
          where,
          data,
          select,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
          select?: Record<string, boolean>;
        }) => {
          const row = store.rows.find((r) => r.id === where.id);
          if (!row) throw new Error("not found");
          Object.assign(row, data, { updatedAt: new Date() });
          return workspace(row, select);
        },
        delete: async ({ where }: { where: { id: string } }) => {
          store.rows = store.rows.filter((r) => r.id !== where.id);
        },
      },
      organization: {
        findUnique: async () => ({ ssoRequired: store.ssoRequired }),
      },
    },
  };
});

import { initCrypto } from "../../providers/crypto";
import {
  createConnection,
  deleteConnection,
  testConnection,
  updateConnection,
  type CognitoIdpOps,
} from "./sso-connection-service";
import { providerNameForOrg } from "./cognito-idp-service";
import type { withRedisLock } from "../clients/redis-lock";
import type { SsoUrlFetcher } from "./safe-fetch";

initCrypto({
  encrypt: async (plaintext) => `enc:${plaintext}`,
  decrypt: async (encrypted) => {
    if (!encrypted.startsWith("enc:")) throw new Error("bad ciphertext");
    return encrypted.slice(4);
  },
});

const fakeLock: typeof withRedisLock = async (_key, fn) =>
  fn({ token: "test-token", isHeld: async () => true });

const makeOps = () => {
  const calls: string[] = [];
  const ops: CognitoIdpOps = {
    createProvider: vi.fn(async () => void calls.push("createProvider")),
    updateProviderDetails: vi.fn(
      async () => void calls.push("updateProviderDetails"),
    ),
    deleteProvider: vi.fn(async () => void calls.push("deleteProvider")),
    mergeProviderIntoClient: vi.fn(
      async () => void calls.push("mergeIntoClient"),
    ),
    removeProviderFromClient: vi.fn(
      async () => void calls.push("removeFromClient"),
    ),
  };
  return { ops, calls };
};

const dupError = () => {
  const err = new Error("DuplicateProviderException");
  err.name = "DuplicateProviderException";
  return err;
};

const samlInput = {
  type: "saml" as const,
  displayName: "Acme Okta",
  metadataXml: `<EntityDescriptor><KeyDescriptor use="signing"><X509Certificate>AAAA</X509Certificate></KeyDescriptor></EntityDescriptor>`,
};

const oidcInput = {
  type: "oidc" as const,
  displayName: "Acme OIDC",
  issuer: "https://login.acme.com",
  clientId: "cid",
  clientSecret: "topsecret",
};

beforeEach(() => {
  store.rows = [];
  store.seq = 0;
  store.ssoRequired = false;
});

describe("createConnection", () => {
  it("creates a pending row with encrypted credentials", async () => {
    const { ops, calls } = makeOps();
    const conn = await createConnection(
      "org-1",
      oidcInput,
      "u1",
      ops,
      fakeLock,
    );
    expect(conn.status).toBe("pending");
    expect(calls).toEqual(["createProvider", "mergeIntoClient"]);
    const row = store.rows[0]!;
    expect(row.credentials).toBe(`enc:{"clientSecret":"topsecret"}`);
    expect(conn).not.toHaveProperty("credentials");
    expect((conn.config as { clientId?: string }).clientId).toBe("cid");
  });

  it("409s when the org already has a connection", async () => {
    const { ops } = makeOps();
    await createConnection("org-1", samlInput, "u1", ops, fakeLock);
    await expect(
      createConnection("org-1", samlInput, "u1", ops, fakeLock),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("adopts an orphaned provider no row references", async () => {
    const { ops } = makeOps();
    (ops.createProvider as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      dupError(),
    );
    const conn = await createConnection(
      "org-1",
      samlInput,
      "u1",
      ops,
      fakeLock,
    );
    expect(ops.updateProviderDetails).toHaveBeenCalledTimes(1);
    expect(conn.status).toBe("pending");
  });

  it("refuses to adopt a provider referenced by a row", async () => {
    const { ops } = makeOps();
    store.rows.push({
      id: "conn-x",
      organizationId: "org-2",
      cognitoProviderName: providerNameForOrg("org-1"),
    });
    (ops.createProvider as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      dupError(),
    );
    await expect(
      createConnection("org-1", samlInput, "u1", ops, fakeLock),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(ops.updateProviderDetails).not.toHaveBeenCalled();
    expect(ops.deleteProvider).not.toHaveBeenCalled();
  });

  it("compensates its own provider when the client merge fails", async () => {
    const { ops } = makeOps();
    (
      ops.mergeProviderIntoClient as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("merge failed"));
    await expect(
      createConnection("org-1", samlInput, "u1", ops, fakeLock),
    ).rejects.toThrow("merge failed");
    expect(ops.deleteProvider).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(0);
  });

  it("extracts SAML signing-cert expiry into config", async () => {
    const { ops } = makeOps();
    const conn = await createConnection(
      "org-1",
      samlInput,
      "u1",
      ops,
      fakeLock,
    );
    // The fixture cert is garbage base64 — expiry parsing degrades to null.
    expect(
      (conn.config as { certExpiresAt: string | null }).certExpiresAt,
    ).toBeNull();
  });
});

describe("updateConnection lifecycle", () => {
  it("disable = teardown + priorStatus saved; enable restores it", async () => {
    const { ops, calls } = makeOps();
    const conn = await createConnection(
      "org-1",
      oidcInput,
      "u1",
      ops,
      fakeLock,
    );
    calls.length = 0;

    const disabled = await updateConnection(
      "org-1",
      conn.id,
      { enabled: false },
      ops,
      fakeLock,
    );
    expect(disabled.status).toBe("disabled");
    expect(calls).toEqual(["removeFromClient", "deleteProvider"]);
    expect((disabled.config as { priorStatus?: string }).priorStatus).toBe(
      "pending",
    );

    calls.length = 0;
    const enabled = await updateConnection(
      "org-1",
      conn.id,
      { enabled: true },
      ops,
      fakeLock,
    );
    expect(enabled.status).toBe("pending"); // never mints "active"
    expect(calls).toEqual(["createProvider", "mergeIntoClient"]);
    expect(
      (enabled.config as { priorStatus?: string }).priorStatus,
    ).toBeUndefined();
  });

  it("rotates the OIDC secret and re-encrypts", async () => {
    const { ops } = makeOps();
    const conn = await createConnection(
      "org-1",
      oidcInput,
      "u1",
      ops,
      fakeLock,
    );
    await updateConnection(
      "org-1",
      conn.id,
      { clientSecret: "rotated" },
      ops,
      fakeLock,
    );
    expect(store.rows[0]!.credentials).toBe(`enc:{"clientSecret":"rotated"}`);
    expect(ops.updateProviderDetails).toHaveBeenCalledTimes(1);
  });

  it("refreshes while disabled without touching Cognito", async () => {
    const { ops } = makeOps();
    const conn = await createConnection(
      "org-1",
      oidcInput,
      "u1",
      ops,
      fakeLock,
    );
    await updateConnection("org-1", conn.id, { enabled: false }, ops, fakeLock);
    (ops.updateProviderDetails as ReturnType<typeof vi.fn>).mockClear();
    await updateConnection(
      "org-1",
      conn.id,
      { clientSecret: "new" },
      ops,
      fakeLock,
    );
    expect(ops.updateProviderDetails).not.toHaveBeenCalled();
    expect(store.rows[0]!.credentials).toBe(`enc:{"clientSecret":"new"}`);
  });

  it("404s cross-org", async () => {
    const { ops } = makeOps();
    const conn = await createConnection(
      "org-1",
      oidcInput,
      "u1",
      ops,
      fakeLock,
    );
    await expect(
      updateConnection("org-2", conn.id, { displayName: "x" }, ops, fakeLock),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("deleteConnection", () => {
  it("removes from client before deleting the provider, then the row", async () => {
    const { ops, calls } = makeOps();
    const conn = await createConnection(
      "org-1",
      samlInput,
      "u1",
      ops,
      fakeLock,
    );
    calls.length = 0;
    await deleteConnection("org-1", conn.id, ops, fakeLock);
    expect(calls).toEqual(["removeFromClient", "deleteProvider"]);
    expect(store.rows).toHaveLength(0);
  });
});

describe("require-SSO lockout guards", () => {
  it("refuses to disable the connection while the org requires SSO", async () => {
    const { ops, calls } = makeOps();
    const conn = await createConnection(
      "org-1",
      samlInput,
      "u1",
      ops,
      fakeLock,
    );
    store.ssoRequired = true;
    calls.length = 0;

    await expect(
      updateConnection("org-1", conn.id, { enabled: false }, ops, fakeLock),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toHaveLength(0); // Cognito untouched

    // Display-name-only changes stay allowed while enforced.
    await updateConnection(
      "org-1",
      conn.id,
      { displayName: "Renamed" },
      ops,
      fakeLock,
    );
  });

  it("refuses to delete the connection while the org requires SSO", async () => {
    const { ops, calls } = makeOps();
    const conn = await createConnection(
      "org-1",
      samlInput,
      "u1",
      ops,
      fakeLock,
    );
    store.ssoRequired = true;
    calls.length = 0;

    await expect(
      deleteConnection("org-1", conn.id, ops, fakeLock),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toHaveLength(0);
    expect(store.rows).toHaveLength(1);
  });
});

describe("testConnection", () => {
  const withConnection = async (
    input: typeof samlInput | typeof oidcInput,
    configOverride?: Record<string, unknown>,
  ) => {
    const { ops } = makeOps();
    const conn = await createConnection("org-1", input, "u1", ops, fakeLock);
    if (configOverride) {
      Object.assign(
        store.rows[0]!.config as Record<string, unknown>,
        configOverride,
      );
    }
    return conn;
  };

  it("passes OIDC discovery with a matching issuer", async () => {
    const conn = await withConnection(oidcInput);
    const fetcher: SsoUrlFetcher = async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ issuer: "https://login.acme.com" }),
    });
    const result = await testConnection("org-1", conn.id, fetcher);
    expect(result.ok).toBe(true);
  });

  it("fails on issuer mismatch", async () => {
    const conn = await withConnection(oidcInput);
    const fetcher: SsoUrlFetcher = async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ issuer: "https://evil.example" }),
    });
    const result = await testConnection("org-1", conn.id, fetcher);
    expect(result.ok).toBe(false);
  });

  it("fails when discovery is unreachable", async () => {
    const conn = await withConnection(oidcInput);
    const fetcher: SsoUrlFetcher = async () => ({
      ok: false,
      reason: "Request failed or timed out",
    });
    const result = await testConnection("org-1", conn.id, fetcher);
    expect(result.ok).toBe(false);
    expect(result.checks[0]!.detail).toContain("failed");
  });

  it("validates stored SAML metadata shape", async () => {
    const conn = await withConnection(samlInput);
    const fetcher: SsoUrlFetcher = async () => {
      throw new Error("must not fetch for stored XML");
    };
    const result = await testConnection("org-1", conn.id, fetcher);
    expect(result.checks.some((c) => c.name.includes("EntityDescriptor"))).toBe(
      true,
    );
  });

  // The per-org test throttle moved to the route layer (ee/middleware/
  // rate-limit.ts on POST /:connectionId/test) — covered by
  // rate-limit.test.ts; the service is throttle-free by design.
});
