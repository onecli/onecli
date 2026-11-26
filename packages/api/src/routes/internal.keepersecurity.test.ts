import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// The gateway's door to the Keeper SDK. What matters here is the contract the
// Rust side depends on: the shared-secret guard, the request shapes, and that a
// service failure reaches the caller as a 400 (not a 500), because the gateway
// reads 400 as "this reference is stale" and 5xx as "Keeper is down, back off".

vi.hoisted(() => {
  process.env.GATEWAY_INTERNAL_SECRET = "test-gateway-secret";
});

const keepersecurity = vi.hoisted(() => ({
  KSM_CONFIG_FORMATS: ["json", "base64"] as const,
  normalizeConfig: vi.fn(),
  bindOneTimeToken: vi.fn(),
  getRecordFields: vi.fn(),
  listRecords: vi.fn(),
  resolveSecret: vi.fn(),
  validateConfig: vi.fn(),
}));

vi.mock("../services/keepersecurity-service", () => keepersecurity);
vi.mock("../services/onepassword-service", () => ({
  getItemFields: vi.fn(),
  listItems: vi.fn(),
  listVaults: vi.fn(),
  resolveSecret: vi.fn(),
  validateToken: vi.fn(),
}));

import { errorHandler } from "../middleware/error-handler";
import { ServiceError } from "../services/errors";
import { internalRoutes } from "./internal";

const app = new Hono().route("/v1/internal", internalRoutes());
app.onError(errorHandler);

const post = (path: string, body: unknown, secret = "test-gateway-secret") =>
  app.request(`/v1/internal/keepersecurity/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "X-Gateway-Secret": secret } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => vi.clearAllMocks());

describe("internal Keeper routes: authentication", () => {
  it.each(["bind", "validate", "resolve", "list-records", "list-fields"])(
    "%s rejects a missing gateway secret",
    async (route) => {
      const res = await post(
        route,
        { token: "x", config: "x", keepersecurity_ref: "x" },
        "",
      );
      expect(res.status).toBe(401);
    },
  );

  it.each(["bind", "validate", "resolve", "list-records", "list-fields"])(
    "%s rejects a wrong gateway secret",
    async (route) => {
      const res = await post(
        route,
        { token: "x", config: "x", keepersecurity_ref: "x" },
        "nope",
      );
      expect(res.status).toBe(401);
    },
  );

  it("never reaches the SDK without the secret", async () => {
    await post(
      "resolve",
      { config: "c", keepersecurity_ref: "keeper://u/field/p" },
      "",
    );
    expect(keepersecurity.resolveSecret).not.toHaveBeenCalled();
  });
});

describe("POST /keepersecurity/bind", () => {
  it("returns the bound config", async () => {
    keepersecurity.bindOneTimeToken.mockResolvedValue('{"clientId":"c"}');
    const res = await post("bind", { token: "US:abc" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ config: '{"clientId":"c"}' });
    expect(keepersecurity.bindOneTimeToken).toHaveBeenCalledWith("US:abc");
  });

  it("rejects a missing token", async () => {
    const res = await post("bind", {});
    expect(res.status).toBe(400);
    expect(keepersecurity.bindOneTimeToken).not.toHaveBeenCalled();
  });

  it("rejects an empty token", async () => {
    expect((await post("bind", { token: "" })).status).toBe(400);
  });

  it("maps a failed bind to 400", async () => {
    keepersecurity.bindOneTimeToken.mockRejectedValue(
      new ServiceError("BAD_REQUEST", "could not be bound"),
    );
    const res = await post("bind", { token: "US:abc" });
    expect(res.status).toBe(400);
    expect(
      ((await res.json()) as { error: { message: string } }).error.message,
    ).toContain("could not be bound");
  });
});

describe("POST /keepersecurity/validate", () => {
  it("returns valid when Keeper accepts the config", async () => {
    keepersecurity.validateConfig.mockResolvedValue(undefined);
    const res = await post("validate", { config: "cfg" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
    expect(keepersecurity.validateConfig).toHaveBeenCalledWith("cfg");
  });

  it("rejects a missing config", async () => {
    expect((await post("validate", {})).status).toBe(400);
  });

  it("maps a validation failure to 400", async () => {
    keepersecurity.validateConfig.mockRejectedValue(
      new ServiceError("BAD_REQUEST", "denied"),
    );
    expect((await post("validate", { config: "cfg" })).status).toBe(400);
  });
  // Pairing with a pasted config: decoded as the user said it is, validated,
  // and handed back in the form the gateway stores.
  it.each(["json", "base64"])(
    "decodes a %s config as told, validates the result, and returns it",
    async (format) => {
      keepersecurity.normalizeConfig.mockReturnValue('{"clientId":"c"}');
      keepersecurity.validateConfig.mockResolvedValue({ recordCount: 2 });
      const res = await post("validate", { config: "pasted", format });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        valid: true,
        recordCount: 2,
        config: '{"clientId":"c"}',
      });
      expect(keepersecurity.normalizeConfig).toHaveBeenCalledWith(
        "pasted",
        format,
      );
      expect(keepersecurity.validateConfig).toHaveBeenCalledWith(
        '{"clientId":"c"}',
      );
    },
  );

  // A status check sends the stored form: nothing to decode, nothing to echo.
  it("does not decode or return the config without a format", async () => {
    keepersecurity.validateConfig.mockResolvedValue({ recordCount: 1 });
    const res = await post("validate", { config: "stored" });
    expect(await res.json()).toEqual({ valid: true, recordCount: 1 });
    expect(keepersecurity.normalizeConfig).not.toHaveBeenCalled();
  });

  it("rejects an unknown format", async () => {
    const res = await post("validate", { config: "c", format: "yaml" });
    expect(res.status).toBe(400);
    expect(keepersecurity.validateConfig).not.toHaveBeenCalled();
  });
});

describe("POST /keepersecurity/resolve", () => {
  const REF = "keeper://uid/field/password";

  it("returns the value for a reference", async () => {
    keepersecurity.resolveSecret.mockResolvedValue("hunter2");
    const res = await post("resolve", {
      config: "cfg",
      keepersecurity_ref: REF,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: "hunter2" });
    expect(keepersecurity.resolveSecret).toHaveBeenCalledWith("cfg", REF);
  });

  it.each([
    ["no config", { keepersecurity_ref: REF }],
    ["no reference", { config: "cfg" }],
    ["an empty reference", { config: "cfg", keepersecurity_ref: "" }],
    ["the 1Password field name", { config: "cfg", op_ref: REF }],
  ])("rejects %s", async (_name, body) => {
    const res = await post("resolve", body);
    expect(res.status).toBe(400);
    expect(keepersecurity.resolveSecret).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    expect((await post("resolve", "not json")).status).toBe(400);
  });

  it("answers a stale reference with 400, which the gateway treats as 'skip this secret'", async () => {
    keepersecurity.resolveSecret.mockRejectedValue(
      new ServiceError(
        "BAD_REQUEST",
        `cannot resolve ${REF}: no records match`,
      ),
    );
    const res = await post("resolve", {
      config: "cfg",
      keepersecurity_ref: REF,
    });
    expect(res.status).toBe(400);
  });

  it("does not leak the config in an error body", async () => {
    keepersecurity.resolveSecret.mockRejectedValue(
      new ServiceError("BAD_REQUEST", "bad"),
    );
    const res = await post("resolve", {
      config: "SECRET-CONFIG-BLOB",
      keepersecurity_ref: REF,
    });
    expect(await res.text()).not.toContain("SECRET-CONFIG-BLOB");
  });
});

describe("POST /keepersecurity/list-records", () => {
  it("returns the records under `records`", async () => {
    const records = [{ uid: "u1", title: "GitHub", type: "login" }];
    keepersecurity.listRecords.mockResolvedValue(records);
    const res = await post("list-records", { config: "cfg" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ records });
    expect(keepersecurity.listRecords).toHaveBeenCalledWith("cfg");
  });

  it("rejects a missing config", async () => {
    expect((await post("list-records", {})).status).toBe(400);
    expect(keepersecurity.listRecords).not.toHaveBeenCalled();
  });

  it("maps a Keeper failure to 400", async () => {
    keepersecurity.listRecords.mockRejectedValue(
      new ServiceError("BAD_REQUEST", "denied"),
    );
    expect((await post("list-records", { config: "cfg" })).status).toBe(400);
  });
});

describe("POST /keepersecurity/list-fields", () => {
  it("returns the fields under `fields`", async () => {
    const fields = [
      {
        ref: "keeper://u1/field/password",
        label: "Password",
        fieldType: "password",
      },
    ];
    keepersecurity.getRecordFields.mockResolvedValue(fields);
    const res = await post("list-fields", { config: "cfg", recordUid: "u1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fields });
    expect(keepersecurity.getRecordFields).toHaveBeenCalledWith("cfg", "u1");
  });

  it.each([
    ["no record", { config: "cfg" }],
    ["an empty record", { config: "cfg", recordUid: "" }],
    ["no config", { recordUid: "u1" }],
  ])("rejects %s", async (_name, body) => {
    expect((await post("list-fields", body)).status).toBe(400);
    expect(keepersecurity.getRecordFields).not.toHaveBeenCalled();
  });

  it("answers an unshared record with 404", async () => {
    keepersecurity.getRecordFields.mockRejectedValue(
      new ServiceError("NOT_FOUND", "not shared"),
    );
    const res = await post("list-fields", { config: "cfg", recordUid: "u1" });
    expect(res.status).toBe(404);
  });
});
