import { beforeEach, describe, expect, it, vi } from "vitest";

// The SSH terminator surface's HTTP contract (sandbox-platform step 5):
// static-secret separation in BOTH directions (the one-credential-per-plane
// law), hint-free 401s, the dark posture when the secret is unset, and the
// three verbs' shapes. Service behavior (cert verification, the access law,
// caps, leases) lives in ssh.pg.test.ts and ssh-service tests — mocked here.

const TERMINATOR_SECRET = "ssh-terminator-secret-value";
const RUNNER_TOKEN = "rnr_known-runner-token";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SSH_TERMINATOR_SECRET = "ssh-terminator-secret-value";
});

const services = vi.hoisted(() => ({
  openSshSession: vi.fn(),
  heartbeatSshSession: vi.fn(),
  closeSshSession: vi.fn(),
}));

vi.mock("../services/ssh-service", () => ({
  openSshSession: services.openSshSession,
  heartbeatSshSession: services.heartbeatSshSession,
  closeSshSession: services.closeSshSession,
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    runner: {
      findUnique: async ({ where }: { where: { token: string } }) =>
        where.token === RUNNER_TOKEN ? { id: "r-1", name: "laptop" } : null,
      update: async () => ({}),
    },
  },
}));

import { Hono } from "hono";

import { errorHandler } from "../middleware/error-handler";
import { runnerAuth } from "../middleware/runner-auth";
import { sshTerminatorRoutes } from "./ssh-terminator";

// A production-shaped composition: the terminator surface beside a
// runner-authenticated surface, so the cross-family fences are provable in
// both directions against real middleware.
const buildApp = () => {
  const app = new Hono().basePath("/v1");
  app.onError(errorHandler);
  app.route("/ssh-terminator", sshTerminatorRoutes());
  const runnerish = new Hono();
  runnerish.use("*", runnerAuth);
  runnerish.get("/probe", (c) => c.json({ ok: true }));
  app.route("/runner", runnerish);
  return app;
};

const openBody = JSON.stringify({
  certificate: "ssh-ed25519-cert-v01@openssh.com AAAA",
  sourceIp: "203.0.113.7",
});

const post = (
  app: Hono,
  path: string,
  headers: Record<string, string>,
  body?: string,
) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body ?? openBody,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("terminator auth", () => {
  it("refuses a missing secret with a hint-free 401", async () => {
    const res = await post(buildApp(), "/v1/ssh-terminator/sessions", {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(services.openSshSession).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret with the identical body", async () => {
    const res = await post(buildApp(), "/v1/ssh-terminator/sessions", {
      "x-terminator-secret": "wrong",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("refuses an rnr_ runner token — no other family passes here", async () => {
    const res = await post(buildApp(), "/v1/ssh-terminator/sessions", {
      authorization: `Bearer ${RUNNER_TOKEN}`,
    });
    expect(res.status).toBe(401);
  });

  it("the terminator secret passes nowhere else — the runner surface refuses it", async () => {
    const res = await buildApp().request("/v1/runner/probe", {
      headers: { "x-terminator-secret": TERMINATOR_SECRET },
    });
    expect(res.status).toBe(401);
  });
});

describe("session verbs", () => {
  const authed = { "x-terminator-secret": TERMINATOR_SECRET };

  it("opens a session through the service and returns its result", async () => {
    services.openSshSession.mockResolvedValue({
      sessionId: "sess-1",
      grant: "grant-b64",
      policy: {
        maxSessionSeconds: 1,
        idleTimeoutSeconds: 2,
        heartbeatSeconds: 3,
      },
    });
    const res = await post(buildApp(), "/v1/ssh-terminator/sessions", authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sessionId: "sess-1",
      grant: "grant-b64",
    });
    expect(services.openSshSession).toHaveBeenCalledWith(
      "ssh-ed25519-cert-v01@openssh.com AAAA",
      "203.0.113.7",
    );
  });

  it("400s a body without a certificate before the service runs", async () => {
    const res = await post(
      buildApp(),
      "/v1/ssh-terminator/sessions",
      authed,
      JSON.stringify({ sourceIp: "1.2.3.4" }),
    );
    expect(res.status).toBe(400);
    expect(services.openSshSession).not.toHaveBeenCalled();
  });

  it("heartbeats with the attached flag and relays the revocation verdict", async () => {
    services.heartbeatSshSession.mockResolvedValue({
      revoked: true,
      reason: "access_revoked",
    });
    const res = await post(
      buildApp(),
      "/v1/ssh-terminator/sessions/sess-1/heartbeat",
      authed,
      JSON.stringify({ attached: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      revoked: true,
      reason: "access_revoked",
    });
    expect(services.heartbeatSshSession).toHaveBeenCalledWith("sess-1", true);
  });

  it("closes with a reason and answers 204", async () => {
    services.closeSshSession.mockResolvedValue(undefined);
    const res = await post(
      buildApp(),
      "/v1/ssh-terminator/sessions/sess-1/close",
      authed,
      JSON.stringify({ reason: "client_disconnect" }),
    );
    expect(res.status).toBe(204);
    expect(services.closeSshSession).toHaveBeenCalledWith(
      "sess-1",
      "client_disconnect",
    );
  });
});
