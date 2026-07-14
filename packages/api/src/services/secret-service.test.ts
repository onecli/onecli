import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Stubs ──

const mockCreate = vi.fn();
const mockFindFirst = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@onecli/db", () => ({
  db: {
    secret: {
      create: (...args: unknown[]) => mockCreate(...args),
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
  Prisma: { JsonNull: "JsonNull" },
}));

vi.mock("../providers", () => ({
  getCrypto: () => ({
    encrypt: (v: string) => Promise.resolve(`encrypted:${v}`),
    decrypt: (v: string) => Promise.resolve(v.replace("encrypted:", "")),
  }),
}));

import { createSecret, updateSecret } from "./secret-service";
import type { ResourceScope } from "./resource-scope";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
const callData = (mock: ReturnType<typeof vi.fn>): any =>
  mock.mock.calls[0]![0].data;

const projectScope: ResourceScope = { projectId: "proj-1" };

const validSaJson = JSON.stringify({
  type: "service_account",
  project_id: "my-project",
  private_key:
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n",
  client_email: "test@my-project.iam.gserviceaccount.com",
  client_id: "123456789",
});

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({
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

describe("createSecret — google_service_account", () => {
  it("stores metadata with clientEmail and projectId", async () => {
    await createSecret(projectScope, {
      name: "Google SA",
      type: "google_service_account",
      hostPattern: "www.googleapis.com",
      value: validSaJson,
    });

    const data = callData(mockCreate);
    expect(data.metadata).toEqual({
      clientEmail: "test@my-project.iam.gserviceaccount.com",
      projectId: "my-project",
    });
  });

  it("metadata excludes private_key", async () => {
    await createSecret(projectScope, {
      name: "Google SA",
      type: "google_service_account",
      hostPattern: "www.googleapis.com",
      value: validSaJson,
    });

    const data = callData(mockCreate);
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

    const data = callData(mockCreate);
    expect(data.injectionConfig).toBe("JsonNull");
  });

  it("preserves caller-supplied hostPattern", async () => {
    await createSecret(projectScope, {
      name: "Google SA",
      type: "google_service_account",
      hostPattern: "storage.googleapis.com",
      value: validSaJson,
    });

    const data = callData(mockCreate);
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

    const data = callData(mockCreate);
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

    const data = callData(mockCreate);
    expect(data.metadata).toEqual({
      clientEmail: "test@no-project.iam.gserviceaccount.com",
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
    mockFindFirst.mockResolvedValue({
      id: "sec-1",
      type: "google_service_account",
    });
    mockUpdate.mockResolvedValue({});
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

    const data = callData(mockUpdate);
    expect(data.metadata).toEqual({
      clientEmail: "test@my-project.iam.gserviceaccount.com",
      projectId: "my-project",
    });
  });

  it("does not override hostPattern on value-only update", async () => {
    await updateSecret(projectScope, "sec-1", {
      value: validSaJson,
      valueSource: "inline",
    });

    const data = callData(mockUpdate);
    expect(data.hostPattern).toBeUndefined();
  });

  it("uses explicit hostPattern when provided alongside value", async () => {
    await updateSecret(projectScope, "sec-1", {
      value: validSaJson,
      valueSource: "inline",
      hostPattern: "storage.googleapis.com",
    });

    const data = callData(mockUpdate);
    expect(data.hostPattern).toBe("storage.googleapis.com");
  });

  it("preserves existing hostPattern when switching to 1Password", async () => {
    await updateSecret(projectScope, "sec-1", {
      valueSource: "onepassword",
      opRef: "op://vault/item/field",
    });

    const data = callData(mockUpdate);
    expect(data.hostPattern).toBeUndefined();
    expect(data.valueSource).toBe("onepassword");
    expect(data.encryptedValue).toBeNull();
  });

  it("metadata from value update excludes private_key", async () => {
    await updateSecret(projectScope, "sec-1", {
      value: validSaJson,
      valueSource: "inline",
    });

    const data = callData(mockUpdate);
    expect(data.metadata).not.toHaveProperty("private_key");
    expect(data.metadata).not.toHaveProperty("privateKey");
    expect(data.metadata).toHaveProperty("clientEmail");
  });
});
