import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ResolverRefusedError,
  ResolverUnreachableError,
  type Resolver,
} from "../types";
import type { KubeExecTarget } from "./exec-backend";
import { createKubeResolver } from "./resolver";

/**
 * The kube resolver's wire law, over a REAL socket: the manager's four
 * refusal codes are deterministic (ResolverRefusedError), EVERYTHING else —
 * 401 rotation skew, unknown codes, malformed bodies — is transport-class
 * (the wake poll rides it out, bounded); and a ready answer comes back as a
 * COMPLETE KubeExecTarget: the broker's per-session fields merged with the
 * boot-constant API-server coordinates, plus the parsed expiry that drives
 * the session's reuse-margin cache.
 */

const KUBE = { server: "https://kube.test:443", caFile: "/tmp/ca.crt" };
const INPUT = { certificate: "cert-line", grant: "grant-blob" };

let server: Server;
let resolver: Resolver<KubeExecTarget>;
let answer: { status: number; body: string };
let seen: { authorization: string | undefined; method: string; url: string }[];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({
      authorization: req.headers.authorization,
      method: req.method ?? "",
      url: req.url ?? "",
    });
    req.resume();
    req.on("end", () => {
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("server did not bind");
  }
  resolver = createKubeResolver({
    managerUrl: `http://127.0.0.1:${address.port}`,
    getSecret: () => "broker-secret",
    kube: KUBE,
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  seen = [];
  answer = { status: 200, body: JSON.stringify({ status: "waking" }) };
});

describe("open — the ready merge", () => {
  it("completes the broker's fields with the boot kube coordinates and parses the expiry", async () => {
    const expiresAt = new Date(Date.now() + 600_000);
    answer = {
      status: 200,
      body: JSON.stringify({
        status: "ready",
        namespace: "ws-1",
        pod: "pod-1",
        container: "sandbox",
        token: "tok-1",
        tokenExpiresAt: expiresAt.toISOString(),
      }),
    };
    await expect(resolver.open(INPUT)).resolves.toEqual({
      status: "ready",
      target: {
        namespace: "ws-1",
        pod: "pod-1",
        container: "sandbox",
        token: "tok-1",
        server: KUBE.server,
        caFile: KUBE.caFile,
      },
      expiresAt,
    });
    expect(seen[0]?.authorization).toBe("Bearer broker-secret");
    expect(seen[0]?.url).toBe("/v1/ssh-sessions");
  });

  it("passes a waking answer through", async () => {
    await expect(resolver.open(INPUT)).resolves.toEqual({ status: "waking" });
  });

  it.each([
    ["namespace", { pod: "p", container: "c", token: "t" }],
    ["pod", { namespace: "n", container: "c", token: "t" }],
    ["container", { namespace: "n", pod: "p", token: "t" }],
    ["token", { namespace: "n", pod: "p", container: "c" }],
  ])(
    "a ready missing %s is fail-closed transport-class",
    async (_missing, fields) => {
      answer = {
        status: 200,
        body: JSON.stringify({
          status: "ready",
          ...fields,
          tokenExpiresAt: new Date().toISOString(),
        }),
      };
      await expect(resolver.open(INPUT)).rejects.toBeInstanceOf(
        ResolverUnreachableError,
      );
    },
  );

  it("a ready with an unparsable expiry is fail-closed transport-class", async () => {
    answer = {
      status: 200,
      body: JSON.stringify({
        status: "ready",
        namespace: "n",
        pod: "p",
        container: "c",
        token: "t",
        tokenExpiresAt: "not-a-date",
      }),
    };
    await expect(resolver.open(INPUT)).rejects.toBeInstanceOf(
      ResolverUnreachableError,
    );
  });

  it("an unknown status is fail-closed transport-class", async () => {
    answer = { status: 200, body: JSON.stringify({ status: "surprise" }) };
    await expect(resolver.open(INPUT)).rejects.toBeInstanceOf(
      ResolverUnreachableError,
    );
  });
});

describe("open — the refusal vocabulary", () => {
  it.each([
    "ssh_not_configured",
    "cert_refused",
    "grant_refused",
    "identity_mismatch",
  ])("the manager's %s refusal is deterministic", async (code) => {
    answer = {
      status: 403,
      body: JSON.stringify({ error: { code, message: "no" } }),
    };
    const failure = await resolver.open(INPUT).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ResolverRefusedError);
    expect((failure as ResolverRefusedError).code).toBe(code);
  });

  it("a 401 (secret-rotation skew) is transport-class, never a refusal", async () => {
    answer = { status: 401, body: "" };
    await expect(resolver.open(INPUT)).rejects.toBeInstanceOf(
      ResolverUnreachableError,
    );
  });

  it("an unknown refusal code (version skew) is transport-class", async () => {
    answer = {
      status: 403,
      body: JSON.stringify({ error: { code: "novel_code", message: "no" } }),
    };
    await expect(resolver.open(INPUT)).rejects.toBeInstanceOf(
      ResolverUnreachableError,
    );
  });
});

describe("close", () => {
  it("tolerates a 404 (idempotent by contract)", async () => {
    answer = { status: 404, body: "" };
    await expect(resolver.close("sess-1")).resolves.toBeUndefined();
    expect(seen[0]?.method).toBe("DELETE");
    expect(seen[0]?.url).toBe("/v1/ssh-sessions/sess-1");
  });

  it("throws transport-class on any other failure", async () => {
    answer = { status: 500, body: "" };
    await expect(resolver.close("sess-1")).rejects.toBeInstanceOf(
      ResolverUnreachableError,
    );
  });
});
