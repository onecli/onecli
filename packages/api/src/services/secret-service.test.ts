import { beforeEach, describe, expect, it, vi } from "vitest";

// The key-health probe's DEGRADATION law, with the db mocked at the boundary
// (the scan's SQL semantics are proven by secret-service.pg.test.ts against
// real PG): health is decoration on the secrets list, so a failed request-log
// probe must degrade that host's badge to null — never fail the list itself.

const dbMock = vi.hoisted(() => ({
  secret: {
    findMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  requestLog: { findFirst: vi.fn() },
}));

vi.mock("@onecli/db", () => ({ db: dbMock, Prisma: { JsonNull: null } }));
// The auto-attach arms and the crypto seam are mocked away from the service's
// own concerns: this suite pins the host-pattern forcing, nothing downstream.
vi.mock("../providers", () => ({
  getCrypto: () => ({ encrypt: async (v: string) => `enc:${v}` }),
}));
vi.mock("./llm-autoattach-service", () => ({
  attachLlmKeyToKeylessAgents: async () => ({ agentIds: [] }),
}));
vi.mock("./workspace-autoattach-service", () => ({
  attachNewSecretToAllAgents: async () => ({ secrets: [] }),
}));

import { createSecret, listSecrets, updateSecret } from "./secret-service";

const anthropicKey = {
  id: "sec-1",
  name: "Anthropic key",
  type: "anthropic",
  valueSource: "inline",
  opRef: null,
  hostPattern: "api.anthropic.com",
  pathPattern: null,
  injectionConfig: null,
  metadata: null,
  scope: "workspace",
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

const SCOPE = { workspaceId: "ws-1", organizationId: "org-1" };

describe("listSecrets key-health degradation", () => {
  beforeEach(() => {
    dbMock.secret.findMany.mockReset();
    dbMock.requestLog.findFirst.mockReset();
    dbMock.secret.findMany.mockResolvedValue([anthropicKey]);
  });

  it("positive control: a branding probe result reaches the row", async () => {
    const at = new Date();
    dbMock.requestLog.findFirst.mockResolvedValue({
      status: 401,
      createdAt: at,
    });

    const rows = await listSecrets(SCOPE);
    expect(rows[0]?.lastError).toEqual({ status: 401, at });
  });

  it("a failed probe degrades to no badge — never a failed secrets list", async () => {
    dbMock.requestLog.findFirst.mockRejectedValue(
      new Error("db connection reset"),
    );

    const rows = await listSecrets(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastError).toBeNull();
  });
});

describe("LLM key host patterns are forced, never user-supplied", () => {
  beforeEach(() => {
    dbMock.secret.create.mockReset();
    dbMock.secret.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "sec-new",
        name: data.name,
        type: data.type,
        valueSource: data.valueSource,
        opRef: null,
        hostPattern: data.hostPattern,
        pathPattern: null,
        createdAt: new Date("2026-08-01T00:00:00Z"),
      }),
    );
  });

  it.each([
    ["opencode-go", "opencode.ai"],
    ["openrouter", "openrouter.ai"],
  ] as const)(
    "forces a %s key onto %s even when the client sends another host",
    async (type, host) => {
      await createSecret(
        { workspaceId: "ws-1" },
        {
          name: "key",
          type,
          hostPattern: "evil.example.com",
          value: "sk-secret-value",
        },
        null,
      );

      const data = dbMock.secret.create.mock.calls[0]?.[0]?.data as {
        hostPattern: string;
      };
      expect(data.hostPattern).toBe(host);
    },
  );
});

describe("a typed LLM key's host cannot be re-pointed by an update", () => {
  beforeEach(() => {
    dbMock.secret.findFirst.mockReset();
    dbMock.secret.update.mockReset();
    dbMock.secret.update.mockResolvedValue({});
  });

  it.each([
    ["opencode-go", "opencode.ai"],
    ["openrouter", "openrouter.ai"],
  ] as const)(
    "keeps a %s key on %s despite a client hostPattern",
    async (type, host) => {
      dbMock.secret.findFirst.mockResolvedValue({ id: "sec-x", type });

      await updateSecret({ workspaceId: "ws-1" }, "sec-x", {
        value: "sk-new-value",
        hostPattern: "evil.example.com",
      });

      const data = dbMock.secret.update.mock.calls[0]?.[0]?.data as {
        hostPattern: string;
      };
      expect(data.hostPattern).toBe(host);
    },
  );

  it("still lets a GENERIC secret move its host (the gate is LLM keys only)", async () => {
    dbMock.secret.findFirst.mockResolvedValue({ id: "sec-g", type: "generic" });

    await updateSecret({ workspaceId: "ws-1" }, "sec-g", {
      hostPattern: "internal.example.com",
    });

    const data = dbMock.secret.update.mock.calls[0]?.[0]?.data as {
      hostPattern: string;
    };
    expect(data.hostPattern).toBe("internal.example.com");
  });
});

describe("a `local` secret derives its host from its base URL", () => {
  beforeEach(() => {
    dbMock.secret.create.mockReset();
    dbMock.secret.findFirst.mockReset();
    dbMock.secret.update.mockReset();
    dbMock.secret.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "sec-local",
        name: data.name,
        type: data.type,
        hostPattern: data.hostPattern,
        pathPattern: null,
        createdAt: new Date("2026-08-01T00:00:00Z"),
      }),
    );
    dbMock.secret.update.mockResolvedValue({});
  });

  it("forces the host pattern from the base URL and stores it in metadata", async () => {
    await createSecret(
      { workspaceId: "ws-1" },
      {
        name: "Ollama",
        type: "local",
        hostPattern: "evil.example.com",
        baseUrl: "http://192.168.1.50:11434/v1",
        value: "",
      },
      null,
    );

    const data = dbMock.secret.create.mock.calls[0]?.[0]?.data as {
      hostPattern: string;
      pathPattern: string | null;
      metadata: { baseUrl: string };
      encryptedValue: string | null;
    };
    expect(data.hostPattern).toBe("192.168.1.50");
    expect(data.pathPattern).toBeNull();
    expect(data.metadata).toEqual({ baseUrl: "http://192.168.1.50:11434/v1" });
    // Keyless: no value is stored, so the gateway injects nothing.
    expect(data.encryptedValue).toBeNull();
  });

  it("allows an empty value (the server may be keyless)", async () => {
    await expect(
      createSecret(
        { workspaceId: "ws-1" },
        {
          name: "LM Studio",
          type: "local",
          hostPattern: "ignored.example.com",
          baseUrl: "https://lm.internal:1234/v1",
          value: "",
        },
        null,
      ),
    ).resolves.toBeDefined();
  });

  it("re-points the host and metadata when only the base URL is updated", async () => {
    dbMock.secret.findFirst.mockResolvedValue({
      id: "sec-local",
      type: "local",
      metadata: { baseUrl: "http://192.168.1.50:11434/v1" },
    });

    await updateSecret({ workspaceId: "ws-1" }, "sec-local", {
      baseUrl: "http://10.0.0.9:1234/v1",
    });

    const data = dbMock.secret.update.mock.calls[0]?.[0]?.data as {
      hostPattern: string;
      pathPattern: string | null;
      metadata: { baseUrl: string };
    };
    expect(data.hostPattern).toBe("10.0.0.9");
    expect(data.pathPattern).toBeNull();
    expect(data.metadata).toEqual({ baseUrl: "http://10.0.0.9:1234/v1" });
  });
});
