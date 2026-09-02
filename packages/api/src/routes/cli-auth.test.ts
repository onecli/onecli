import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The confirm-POST origin gate. Pre-refactor it compared the Origin header
// against the localhost-DEFAULTED APP_URL constant — so every LAN self-host
// whose operator never set APP_URL got a 403 on the dashboard's confirm call.
// Now the gate is membership in the resolver's trusted-origins set: the app
// origin, its loopback twin, ONECLI_TRUSTED_ORIGINS extras, and (split-host)
// the api origin — with the dev trust-all branch honored.

vi.mock("../middleware/auth", () => ({
  auth:
    () =>
    async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("auth", { userId: "u1", workspaceId: "w1", organizationId: "o1" });
      return next();
    },
  requireWorkspaceId: () => "w1",
}));

const apiKeyFindFirst = vi.hoisted(() =>
  vi.fn(async () => ({ key: `oc_${"a".repeat(64)}` })),
);
vi.mock("@onecli/db", () => ({
  db: { apiKey: { findFirst: apiKeyFindFirst } },
}));

vi.mock("../services/cli-auth-service", () => ({
  createCliAuthSession: vi.fn(async () => ({ code: "c", auth_url: "u" })),
  pollCliAuthSession: vi.fn(async () => ({ status: "pending" })),
  confirmCliAuthSession: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../services/onboarding-service", () => ({
  markOnboardingCompleteForUser: vi.fn(async () => {}),
}));
vi.mock("../ee/services/workspace-service", () => ({
  getUserOrgsWithWorkspaces: vi.fn(async () => []),
}));

const { cliAuthRoutes } = await import("./cli-auth");

const RESOLVER_ENV = [
  "ONECLI_EXTERNAL_URL",
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "API_URL",
  "NEXT_PUBLIC_API_URL",
  "GATEWAY_API_URL",
  "NEXT_PUBLIC_GATEWAY_API_URL",
  "ONECLI_BIND_HOST",
  "ONECLI_APP_PORT",
  "ONECLI_API_PORT",
  "ONECLI_GATEWAY_PORT",
  "ONECLI_TRUSTED_ORIGINS",
  "DEV_TRUST_ANY_AUTH_ORIGIN",
] as const;

const pin = (env: Record<string, string> = {}) => {
  vi.stubEnv("NODE_ENV", env.NODE_ENV ?? "development");
  for (const key of RESOLVER_ENV) vi.stubEnv(key, env[key] ?? "");
};

const confirm = (origin?: string) =>
  cliAuthRoutes().request("/confirm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ code: "code-1" }),
  });

describe("POST /confirm — origin gate", () => {
  beforeEach(() => apiKeyFindFirst.mockClear());
  afterEach(() => vi.unstubAllEnvs());

  it("passes with no Origin header (the CLI itself)", async () => {
    pin();
    expect((await confirm()).status).toBe(200);
  });

  // The zero-config LAN-403 regression pin: unconfigured installs must
  // accept their own localhost dashboard, twin included.
  it("passes the localhost defaults and the 127.0.0.1 twin when unconfigured", async () => {
    pin();
    expect((await confirm("http://localhost:10254")).status).toBe(200);
    expect((await confirm("http://127.0.0.1:10254")).status).toBe(200);
  });

  it("passes the configured external origin", async () => {
    pin({ ONECLI_EXTERNAL_URL: "http://192.0.2.10:10254" });
    expect((await confirm("http://192.0.2.10:10254")).status).toBe(200);
  });

  it("passes an ONECLI_TRUSTED_ORIGINS extra", async () => {
    pin({
      ONECLI_EXTERNAL_URL: "http://192.0.2.10:10254",
      ONECLI_TRUSTED_ORIGINS: "http://onecli.corp:10254",
    });
    expect((await confirm("http://onecli.corp:10254")).status).toBe(200);
  });

  it("passes the api origin on split hosts", async () => {
    pin({
      ONECLI_EXTERNAL_URL: "https://app.acme.com",
      API_URL: "https://api.acme.com",
    });
    expect((await confirm("https://api.acme.com")).status).toBe(200);
  });

  it("rejects an unlisted origin", async () => {
    pin({ ONECLI_EXTERNAL_URL: "http://192.0.2.10:10254" });
    expect((await confirm("https://evil.example")).status).toBe(403);
  });

  it("rejects a malformed Origin header", async () => {
    pin();
    expect((await confirm("not-an-origin")).status).toBe(403);
  });

  it("honors the dev trust-all branch", async () => {
    pin({ DEV_TRUST_ANY_AUTH_ORIGIN: "1" });
    expect((await confirm("https://anything.example")).status).toBe(200);
  });

  it("keeps the trust-all branch off in production", async () => {
    pin({ DEV_TRUST_ANY_AUTH_ORIGIN: "1", NODE_ENV: "production" });
    expect((await confirm("https://anything.example")).status).toBe(403);
  });
});
