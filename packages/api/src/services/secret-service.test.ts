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

vi.mock("@onecli/db", () => ({
  db: dbMock,
  Prisma: { JsonNull: "JsonNull" },
}));

vi.mock("../providers", () => ({
  getCrypto: () => ({
    encrypt: (v: string) => Promise.resolve(`encrypted:${v}`),
    decrypt: (v: string) => Promise.resolve(v.replace("encrypted:", "")),
  }),
}));

import { createSecret, listSecrets, updateSecret } from "./secret-service";
import { GOOGLE_SA_DEFAULT_SCOPE } from "../validations/secret";
import type { ResourceScope } from "./resource-scope";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
const callData = (mock: ReturnType<typeof vi.fn>): any =>
  mock.mock.calls[0]![0].data;

const projectScope: ResourceScope = { workspaceId: "ws-2" };

const validSaJson = JSON.stringify({
  type: "service_account",
  project_id: "my-project",
  private_key:
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n",
  client_email: "test@my-project.iam.gserviceaccount.com",
  client_id: "123456789",
});

describe("createSecret — google_service_account", () => {
  beforeEach(() => {
    dbMock.secret.create.mockReset();
    dbMock.secret.create.mockResolvedValue({
      id: "sec-1",
      name: "Google SA",
      type: "google_service_account",
      valueSource: "inline",
      opRef: null,
      hostPattern: "www.googleapis.com",
      pathPattern: null,
      createdAt: new Date(),
    });
  });

  it("stores metadata with clientEmail and projectId", async () => {
    await createSecret(projectScope, {
      name: "Google SA",
      type: "google_service_account",
      hostPattern: "www.googleapis.com",
      value: validSaJson,
    });

    const data = callData(dbMock.secret.create);
    expect(data.metadata).toEqual({
      clientEmail: "test@my-project.iam.gserviceaccount.com",
      projectId: "my-project",
      scope: GOOGLE_SA_DEFAULT_SCOPE,
    });
  });

  it("defaults scope to the Drive scope when omitted", async () => {
    await createSecret(projectScope, {
      name: "Google SA",
      type: "google_service_account",
      hostPattern: "www.googleapis.com",
      value: validSaJson,
    });

    const data = callData(mockCreate);
    expect(data.metadata.scope).toBe(GOOGLE_SA_DEFAULT_SCOPE);
  });

  it("persists an explicit scope into metadata", async () => {
    await createSecret(projectScope, {
      name: "Google SA",
      type: "google_service_account",
      hostPattern: "www.googleapis.com",
      value: validSaJson,
      scope: "https://www.googleapis.com/auth/spreadsheets",
    });

    const data = callData(mockCreate);
    expect(data.metadata.scope).toBe(
      "https://www.googleapis.com/auth/spreadsheets",
    );
  });

  it("persists scope for a 1Password-sourced SA secret", async () => {
    await createSecret(projectScope, {
      name: "Google SA",
      type: "google_service_account",
      hostPattern: "www.googleapis.com",
      valueSource: "onepassword",
      opRef: "op://vault/item/field",
      scope: "https://www.googleapis.com/auth/calendar",
    });

    const data = callData(mockCreate);
    expect(data.metadata.scope).toBe(
      "https://www.googleapis.com/auth/calendar",
    );
  });

  it("metadata excludes private_key", async () => {
    await createSecret(projectScope, {
      name: "Google SA",
      type: "google_service_account",
      hostPattern: "www.googleapis.com",
      value: validSaJson,
    });

    const data = callData(dbMock.secret.create);
    expect(data.metadata).not.toHaveProperty("private_key");
    expect(data.metadata).not.toHaveProperty("privateKey");
  });

  it("stores injectionConfig as null", async () => {
    await createSecret(projectScope, {
      name: "Google SA",
      type: "google_service_account",
      hostPattern: "www.googleapis.com",
      value: validSaJson,
    });

    const data = callData(dbMock.secret.create);
    expect(data.injectionConfig).toBe("JsonNull");
  });

  it("preserves caller-supplied hostPattern", async () => {
    await createSecret(projectScope, {
      name: "Google SA",
      type: "google_service_account",
      hostPattern: "storage.googleapis.com",
      value: validSaJson,
    });

    const data = callData(dbMock.secret.create);
    expect(data.hostPattern).toBe("storage.googleapis.com");
  });

  it("preserves explicit hostPattern for 1Password source", async () => {
    await createSecret(projectScope, {
      name: "Google SA",
      type: "google_service_account",
      hostPattern: "storage.googleapis.com",
      valueSource: "onepassword",
      opRef: "op://vault/item/field",
    });

    const data = callData(dbMock.secret.create);
    expect(data.hostPattern).toBe("storage.googleapis.com");
  });

  it("rejects invalid SA JSON", async () => {
    await expect(
      createSecret(projectScope, {
        name: "Google SA",
        type: "google_service_account",
        hostPattern: "www.googleapis.com",
        value: "not-valid-json",
      }),
    ).rejects.toThrow(/service account JSON/);
  });

  it("rejects SA JSON with wrong type field", async () => {
    const wrongType = JSON.stringify({
      ...JSON.parse(validSaJson),
      type: "authorized_user",
    });
    await expect(
      createSecret(projectScope, {
        name: "Google SA",
        type: "google_service_account",
        hostPattern: "www.googleapis.com",
        value: wrongType,
      }),
    ).rejects.toThrow(/service account JSON/);
  });

  it("stores metadata with clientEmail only when project_id is absent", async () => {
    const saWithoutProject = JSON.stringify({
      type: "service_account",
      private_key:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n",
      client_email: "test@no-project.iam.gserviceaccount.com",
    });

    await createSecret(projectScope, {
      name: "Google SA",
      type: "google_service_account",
      hostPattern: "www.googleapis.com",
      value: saWithoutProject,
    });

    const data = callData(dbMock.secret.create);
    expect(data.metadata).toEqual({
      clientEmail: "test@no-project.iam.gserviceaccount.com",
      scope: GOOGLE_SA_DEFAULT_SCOPE,
    });
    expect(data.metadata).not.toHaveProperty("projectId");
  });

  it("rejects SA JSON missing private_key", async () => {
    const noKey = JSON.stringify({
      type: "service_account",
      client_email: "test@my-project.iam.gserviceaccount.com",
      project_id: "my-project",
    });
    await expect(
      createSecret(projectScope, {
        name: "Google SA",
        type: "google_service_account",
        hostPattern: "www.googleapis.com",
        value: noKey,
      }),
    ).rejects.toThrow(/service account JSON/);
  });

  it("rejects SA JSON missing client_email", async () => {
    const noEmail = JSON.stringify({
      type: "service_account",
      private_key:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n",
      project_id: "my-project",
    });
    await expect(
      createSecret(projectScope, {
        name: "Google SA",
        type: "google_service_account",
        hostPattern: "www.googleapis.com",
        value: noEmail,
      }),
    ).rejects.toThrow(/service account JSON/);
  });

  it("error message does not leak private_key value", async () => {
    const badSa = JSON.stringify({
      type: "authorized_user",
      private_key: "SUPER_SECRET_KEY_VALUE",
      client_email: "test@example.com",
    });
    try {
      await createSecret(projectScope, {
        name: "Google SA",
        type: "google_service_account",
        hostPattern: "www.googleapis.com",
        value: badSa,
      });
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("SUPER_SECRET_KEY_VALUE");
    }
  });
});

describe("updateSecret — google_service_account", () => {
  beforeEach(() => {
    dbMock.secret.findFirst.mockReset();
    dbMock.secret.update.mockReset();
    dbMock.secret.findFirst.mockResolvedValue({
      id: "sec-1",
      type: "google_service_account",
    });
    dbMock.secret.update.mockResolvedValue({});
  });

  it("validates SA JSON on value update", async () => {
    await expect(
      updateSecret(projectScope, "sec-1", {
        value: "not-valid-json",
        valueSource: "inline",
      }),
    ).rejects.toThrow(/service account JSON/);
  });

  it("rebuilds metadata on value update", async () => {
    await updateSecret(projectScope, "sec-1", {
      value: validSaJson,
      valueSource: "inline",
    });

    const data = callData(dbMock.secret.update);
    expect(data.metadata).toEqual({
      clientEmail: "test@my-project.iam.gserviceaccount.com",
      projectId: "my-project",
      scope: GOOGLE_SA_DEFAULT_SCOPE,
    });
  });

  it("persists an explicit scope alongside a value update", async () => {
    await updateSecret(projectScope, "sec-1", {
      value: validSaJson,
      valueSource: "inline",
      scope: "https://www.googleapis.com/auth/spreadsheets",
    });

    const data = callData(mockUpdate);
    expect(data.metadata.scope).toBe(
      "https://www.googleapis.com/auth/spreadsheets",
    );
  });

  it("preserves the existing scope on a value-only update", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: "sec-1",
      type: "google_service_account",
      metadata: { scope: "https://www.googleapis.com/auth/calendar" },
    });

    await updateSecret(projectScope, "sec-1", {
      value: validSaJson,
      valueSource: "inline",
    });

    const data = callData(mockUpdate);
    expect(data.metadata.scope).toBe(
      "https://www.googleapis.com/auth/calendar",
    );
  });

  it("updates scope alone, preserving clientEmail/projectId", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: "sec-1",
      type: "google_service_account",
      metadata: {
        clientEmail: "test@my-project.iam.gserviceaccount.com",
        projectId: "my-project",
        scope: GOOGLE_SA_DEFAULT_SCOPE,
      },
    });

    await updateSecret(projectScope, "sec-1", {
      scope: "https://www.googleapis.com/auth/spreadsheets",
    });

    const data = callData(mockUpdate);
    expect(data.metadata).toEqual({
      clientEmail: "test@my-project.iam.gserviceaccount.com",
      projectId: "my-project",
      scope: "https://www.googleapis.com/auth/spreadsheets",
    });
    expect(data.encryptedValue).toBeUndefined();
  });

  it("does not override hostPattern on value-only update", async () => {
    await updateSecret(projectScope, "sec-1", {
      value: validSaJson,
      valueSource: "inline",
    });

    const data = callData(dbMock.secret.update);
    expect(data.hostPattern).toBeUndefined();
  });

  it("uses explicit hostPattern when provided alongside value", async () => {
    await updateSecret(projectScope, "sec-1", {
      value: validSaJson,
      valueSource: "inline",
      hostPattern: "storage.googleapis.com",
    });

    const data = callData(dbMock.secret.update);
    expect(data.hostPattern).toBe("storage.googleapis.com");
  });

  it("preserves existing hostPattern when switching to 1Password", async () => {
    await updateSecret(projectScope, "sec-1", {
      valueSource: "onepassword",
      opRef: "op://vault/item/field",
    });

    const data = callData(dbMock.secret.update);
    expect(data.hostPattern).toBeUndefined();
    expect(data.valueSource).toBe("onepassword");
    expect(data.encryptedValue).toBeNull();
  });

  it("metadata from value update excludes private_key", async () => {
    await updateSecret(projectScope, "sec-1", {
      value: validSaJson,
      valueSource: "inline",
    });

    const data = callData(dbMock.secret.update);
    expect(data.metadata).not.toHaveProperty("private_key");
    expect(data.metadata).not.toHaveProperty("privateKey");
    expect(data.metadata).toHaveProperty("clientEmail");
  });
});
