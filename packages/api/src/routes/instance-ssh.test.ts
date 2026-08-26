import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SSH posture on `GET /v1/instance` — its OWN file because SSH_HOST and
 * SSH_PORT freeze at env.ts import: this file sets them (plus a real
 * in-process CA key so `sshAvailable()` is true) before the app loads, which
 * the sibling instance.test.ts must never do (it proves the dark posture).
 */

// A throwaway ed25519 PKCS#8 PEM (generated once, never used elsewhere) so the
// onprem CA signer parses and sshAvailable() lights the surface — inlined in
// the hoisted block because vi.hoisted runs before imports, and node:crypto in
// a hoisted block trips no-require-imports.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  delete process.env.ENTERPRISE_ENABLED;
  process.env.SSH_HOST = "ssh.onecli.test";
  process.env.SSH_PORT = "10257";
  process.env.SSH_CA_PRIVATE_KEY = [
    "-----BEGIN PRIVATE KEY-----",
    "MC4CAQAwBQYDK2VwBCIEIA2T7WCg6XRy8IeVpD29kTZBRdFZYzXaMK9Fgz1vM1hx",
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n");
});

vi.mock("@onecli/db", () => ({
  db: {
    runner: {
      count: async () => 0,
      findFirst: async () => null,
    },
  },
}));

const { createApiApp } = await import("../app");
const { resetRunnerAvailabilityCache } =
  await import("../services/runner-service");

const app = createApiApp({ getSession: async () => null });

beforeEach(() => {
  resetRunnerAvailabilityCache();
});

describe("GET /v1/instance — SSH posture", () => {
  it("advertises host AND port when the front door is configured", async () => {
    const res = await app.request("/v1/instance");
    const body = (await res.json()) as { ssh?: unknown };
    expect(body.ssh).toEqual({ host: "ssh.onecli.test", port: 10257 });
  });
});
