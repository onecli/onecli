import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseCertificateLine,
  parseEd25519PublicKeyLine,
  signGrant,
  verifyGrant,
} from "@onecli/ssh-cert";
import type { KubeExecTarget } from "./backend/kube/exec-backend";
import { createKubeResolver } from "./backend/kube/resolver";
import { createControlPlaneClient } from "./control-plane-client";
import { createConnectionLimits } from "./limits";
import { createLocalExecBackend } from "./local-exec-backend";
import { createFakeTerminatorMetrics } from "./metrics";
import { createTerminatorServer, type TerminatorServer } from "./server";
import {
  createTestCa,
  mintTestCertificate,
  type TestCa,
} from "./test-fixtures";

/**
 * End-to-end: the REAL terminator server (real ssh2, real cert auth, real
 * session/relay wiring) with in-process fake control-plane and broker HTTP
 * servers and a local child_process exec backend — dialed by the REAL
 * OpenSSH client binaries. This is the interop proof for ssh2's
 * cert-blob-passthrough auth, the PTY relay, and the raw-channel sftp pipe,
 * run before any cluster exists.
 */

const sshAvailable = ((): boolean => {
  const probe = spawnSync("ssh", ["-V"]);
  return probe.error === undefined;
})();

const SFTP_SERVER_CANDIDATES = [
  "/usr/lib/openssh/sftp-server",
  "/usr/libexec/sftp-server",
  "/usr/lib/ssh/sftp-server",
];
const localSftpServer = SFTP_SERVER_CANDIDATES.find((path) => existsSync(path));

const POLICY = {
  maxSessionSeconds: 600,
  idleTimeoutSeconds: 120,
  heartbeatSeconds: 1,
};

interface CliResult {
  code: number | string;
  stdout: string;
  stderr: string;
}

const runCli = (bin: string, args: string[]): Promise<CliResult> =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 255) : 0, stdout, stderr });
    });
  });

const readJsonBody = (request: NodeJS.ReadableStream): Promise<unknown> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
  });

const listen = (server: HttpServer): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(
        address !== null && typeof address === "object" ? address.port : 0,
      );
    });
  });

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? { ...value } : {};

interface FakeControlPlaneRecords {
  opens: Array<{ certificate: string; sourceIp: string }>;
  heartbeats: Array<{ sessionId: string; attached: boolean }>;
  closes: Array<{ sessionId: string; reason: string }>;
}

interface FakeBrokerRecords {
  opens: Array<{ certificate: string; grant: string }>;
  deletes: string[];
}

interface Harness {
  port: number;
  ca: TestCa;
  controlPlane: FakeControlPlaneRecords;
  broker: FakeBrokerRecords;
  metrics: ReturnType<typeof createFakeTerminatorMetrics>;
  close(): Promise<void>;
}

const CP_SECRET = "cp-secret";
const BROKER_SECRET = "broker-secret";
const SESSION_ID = "sess-e2e-1";

const startHarness = async (options?: {
  workDir?: string;
  preauthPerIpPerMinute?: number;
  /** Broker answers `waking` this many times before `ready` (default 1). */
  wakingAnswers?: number;
  /** Make session-open refuse (the per-agent cap / revoked-access shape). */
  openRefusal?: { status: number; message: string };
  /** Latency before the session-open answer (dev's api-server is ~20-300ms). */
  openDelayMs?: number;
  /** Scripted heartbeat statuses (infrastructure noise: a WAF 403, a deploy
   * window's 503) — one shifted per beat; an empty queue answers the clean
   * 200 verdict. */
  heartbeatStatuses?: number[];
}): Promise<Harness> => {
  const ca = createTestCa();
  const controlPlane: FakeControlPlaneRecords = {
    opens: [],
    heartbeats: [],
    closes: [],
  };
  const broker: FakeBrokerRecords = { opens: [], deletes: [] };
  const metrics = createFakeTerminatorMetrics();
  const workDir = options?.workDir ?? mkdtempSync(join(tmpdir(), "term-e2e-"));

  const controlPlaneHttp = createServer((request, response) => {
    void (async () => {
      const body = asRecord(await readJsonBody(request));
      if (request.headers["x-terminator-secret"] !== CP_SECRET) {
        response.writeHead(401).end();
        return;
      }
      const url = request.url ?? "";
      if (request.method === "POST" && url === "/v1/ssh-terminator/sessions") {
        controlPlane.opens.push({
          certificate:
            typeof body.certificate === "string" ? body.certificate : "",
          sourceIp: typeof body.sourceIp === "string" ? body.sourceIp : "",
        });
        if (options?.openDelayMs) {
          await new Promise((done) => setTimeout(done, options.openDelayMs));
        }
        const refusal = options?.openRefusal;
        if (refusal) {
          response
            .writeHead(refusal.status, { "content-type": "application/json" })
            .end(
              JSON.stringify({
                error: { message: refusal.message, type: "conflict_error" },
              }),
            );
          return;
        }
        const grant = await signGrant(
          {
            sessionId: SESSION_ID,
            agentId: "agent-1",
            sandboxId: "sbx-1",
            workspaceId: "ws-1",
            expiresAt: BigInt(Math.floor(Date.now() / 1000) + 600),
          },
          ca.signer,
        );
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify({ sessionId: SESSION_ID, grant, policy: POLICY }),
          );
        return;
      }
      const heartbeat =
        /^\/v1\/ssh-terminator\/sessions\/([^/]+)\/heartbeat$/.exec(url);
      if (request.method === "POST" && heartbeat) {
        controlPlane.heartbeats.push({
          sessionId: decodeURIComponent(heartbeat[1] ?? ""),
          attached: body.attached === true,
        });
        const scripted = options?.heartbeatStatuses?.shift();
        if (scripted !== undefined && scripted !== 200) {
          response
            .writeHead(scripted, { "content-type": "application/json" })
            .end(JSON.stringify({ error: "blocked" }));
          return;
        }
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ revoked: false }));
        return;
      }
      const close = /^\/v1\/ssh-terminator\/sessions\/([^/]+)\/close$/.exec(
        url,
      );
      if (request.method === "POST" && close) {
        controlPlane.closes.push({
          sessionId: decodeURIComponent(close[1] ?? ""),
          reason: typeof body.reason === "string" ? body.reason : "",
        });
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    })();
  });

  let brokerPolls = 0;
  const wakingAnswers = options?.wakingAnswers ?? 1;
  const brokerHttp = createServer((request, response) => {
    void (async () => {
      const body = asRecord(await readJsonBody(request));
      if (request.headers.authorization !== `Bearer ${BROKER_SECRET}`) {
        response.writeHead(401).end();
        return;
      }
      const url = request.url ?? "";
      if (request.method === "POST" && url === "/v1/ssh-sessions") {
        broker.opens.push({
          certificate:
            typeof body.certificate === "string" ? body.certificate : "",
          grant: typeof body.grant === "string" ? body.grant : "",
        });
        brokerPolls += 1;
        const answer =
          brokerPolls <= wakingAnswers
            ? { status: "waking" }
            : {
                status: "ready",
                namespace: "ws-ws-1",
                pod: "sandbox-pod-1",
                container: "sandbox",
                token: "exec-token-1",
                tokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
              };
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(answer));
        return;
      }
      if (request.method === "DELETE" && url.startsWith("/v1/ssh-sessions/")) {
        broker.deletes.push(
          decodeURIComponent(url.slice("/v1/ssh-sessions/".length)),
        );
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    })();
  });

  const [controlPlanePort, brokerPort] = await Promise.all([
    listen(controlPlaneHttp),
    listen(brokerHttp),
  ]);

  // The guest command paths do not exist on a dev machine: land in the test
  // work dir and run the LOCAL sftp-server, keeping the real relay-built
  // command (quoting included) otherwise intact.
  const mapCommand = (command: string[]): string[] => {
    const script = command[command.length - 1] ?? "";
    return [
      "/bin/sh",
      "-c",
      script
        .replace(
          "mkdir -p /workspace/.home 2>/dev/null || true; cd /workspace 2>/dev/null || cd /home/node",
          `cd ${workDir} 2>/dev/null`,
        )
        .replace(
          "/usr/lib/openssh/sftp-server",
          localSftpServer ?? "/usr/lib/openssh/sftp-server",
        ),
    ];
  };

  const server: TerminatorServer = createTerminatorServer({
    hostKey: hostKeyPem,
    caPublicKey: ca.publicKey,
    controlPlane: createControlPlaneClient({
      baseUrl: `http://127.0.0.1:${controlPlanePort}`,
      getSecret: () => CP_SECRET,
    }),
    backend: {
      // The REAL kube resolver against the fake broker HTTP server — the
      // wire parse path stays covered end-to-end; only the exec dial is
      // substituted (the local backend ignores the merged server/caFile).
      resolver: createKubeResolver({
        managerUrl: `http://127.0.0.1:${brokerPort}`,
        getSecret: () => BROKER_SECRET,
        kube: { server: "https://kube.invalid:443", caFile: "/dev/null" },
      }),
      exec: createLocalExecBackend<KubeExecTarget>({ mapCommand }),
    },
    metrics,
    limits: createConnectionLimits({
      maxSessions: 32,
      maxSessionsPerIp: 16,
      preauthPerIpPerMinute: options?.preauthPerIpPerMinute ?? 100,
    }),
    wakeWaitSeconds: 10,
    preauthTimeoutSeconds: 5,
    wakePollMs: 25,
  });
  const port = await server.listen(0, "127.0.0.1");

  return {
    port,
    ca,
    controlPlane,
    broker,
    metrics,
    close: async () => {
      await server.close();
      await new Promise<void>((done) => controlPlaneHttp.close(() => done()));
      await new Promise<void>((done) => brokerHttp.close(() => done()));
    },
  };
};

// One-time key material (real ssh-keygen so the client-side files are in the
// formats OpenSSH expects; the CERTIFICATE is minted by our codec).
const fixturesDir = sshAvailable
  ? mkdtempSync(join(tmpdir(), "term-e2e-keys-"))
  : "";
let hostKeyPem = "";
let userKeyPath = "";
let userCertPath = "";
if (sshAvailable) {
  const hostKeyPath = join(fixturesDir, "host_key");
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKeyPath]);
  hostKeyPem = readFileSync(hostKeyPath, "utf8");
  userKeyPath = join(fixturesDir, "id_ed25519");
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", userKeyPath]);
  userCertPath = `${userKeyPath}-cert.pub`;
}

const mintClientCert = async (
  ca: TestCa,
  overrides: Parameters<typeof mintTestCertificate>[2] = {},
): Promise<void> => {
  const publicKeyLine = readFileSync(`${userKeyPath}.pub`, "utf8");
  const raw = parseEd25519PublicKeyLine(publicKeyLine);
  const cert = await mintTestCertificate(
    ca,
    { publicKey: raw, sign: () => Buffer.alloc(0) },
    overrides,
  );
  writeFileSync(userCertPath, `${cert.line}\n`);
};

const clientOpts = (): string[] => [
  "-F",
  "/dev/null",
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "IdentityAgent=none",
  "-o",
  `CertificateFile=${userCertPath}`,
  "-i",
  userKeyPath,
];

const harnesses: Harness[] = [];
const openHarness = async (
  options?: Parameters<typeof startHarness>[0],
): Promise<Harness> => {
  const harness = await startHarness(options);
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  await Promise.allSettled(harnesses.splice(0).map((h) => h.close()));
});

describe.skipIf(!sshAvailable)("terminator e2e (real OpenSSH client)", () => {
  it("relays an exec round-trip and walks the full session lifecycle", async () => {
    const h = await openHarness();
    await mintClientCert(h.ca);
    const answer = await runCli("ssh", [
      "-tt",
      ...clientOpts(),
      "-p",
      String(h.port),
      "agent-1@127.0.0.1",
      "echo hello-from-guest",
    ]);
    expect(answer.stderr).not.toContain("Permission denied");
    expect(answer.code).toBe(0);
    expect(answer.stdout).toContain("hello-from-guest");
    // The single waking poll surfaced the friendly progress line on the PTY.
    expect(answer.stdout).toContain("waking your agent");

    // Session-open carried the REAL certificate line and the client IP.
    expect(h.controlPlane.opens).toHaveLength(1);
    const opened = h.controlPlane.opens[0];
    const cert = parseCertificateLine(opened?.certificate ?? "");
    expect(cert.principals).toEqual(["agent-1"]);
    expect(opened?.sourceIp).toBe("127.0.0.1");

    // The broker got cert + a grant that verifies against the CA.
    expect(h.broker.opens.length).toBeGreaterThanOrEqual(2);
    const grant = verifyGrant(h.broker.opens[0]?.grant ?? "", h.ca.publicKey);
    expect(grant.sessionId).toBe(SESSION_ID);
    expect(grant.agentId).toBe("agent-1");

    // Attach heartbeat + close report + broker cleanup all landed.
    await vi.waitFor(() => {
      expect(h.controlPlane.heartbeats.some((beat) => beat.attached)).toBe(
        true,
      );
      expect(h.controlPlane.closes).toEqual([
        { sessionId: SESSION_ID, reason: "client_disconnect" },
      ]);
      expect(h.broker.deletes).toContain(SESSION_ID);
    });
    expect(h.metrics.counts.opened).toBe(1);
    expect(h.metrics.counts.closed).toBe(1);
    expect(h.metrics.wakeWaits).toHaveLength(1);
  }, 30_000);

  it("propagates the guest exit code", async () => {
    const h = await openHarness({ wakingAnswers: 0 });
    await mintClientCert(h.ca);
    const answer = await runCli("ssh", [
      ...clientOpts(),
      "-p",
      String(h.port),
      "agent-1@127.0.0.1",
      "exit 7",
    ]);
    expect(answer.code).toBe(7);
  }, 30_000);

  it("refuses a foreign-CA certificate before any session exists", async () => {
    const h = await openHarness();
    const foreignCa = createTestCa();
    await mintClientCert(foreignCa);
    const answer = await runCli("ssh", [
      ...clientOpts(),
      "-o",
      "NumberOfPasswordPrompts=0",
      "-p",
      String(h.port),
      "agent-1@127.0.0.1",
      "echo should-never-run",
    ]);
    expect(answer.code).not.toBe(0);
    expect(answer.stdout).not.toContain("should-never-run");
    expect(h.controlPlane.opens).toHaveLength(0);
    expect(h.broker.opens).toHaveLength(0);
    expect(h.metrics.counts.authFailures).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("refuses an expired certificate", async () => {
    const h = await openHarness();
    await mintClientCert(h.ca, {
      validAfter: new Date(Date.now() - 7_200_000),
      validBefore: new Date(Date.now() - 3_600_000),
    });
    const answer = await runCli("ssh", [
      ...clientOpts(),
      "-o",
      "NumberOfPasswordPrompts=0",
      "-p",
      String(h.port),
      "agent-1@127.0.0.1",
      "echo should-never-run",
    ]);
    expect(answer.code).not.toBe(0);
    expect(answer.stdout).not.toContain("should-never-run");
    expect(h.controlPlane.opens).toHaveLength(0);
  }, 30_000);

  it("refuses the certified principal under the wrong username", async () => {
    const h = await openHarness();
    await mintClientCert(h.ca);
    const answer = await runCli("ssh", [
      ...clientOpts(),
      "-o",
      "NumberOfPasswordPrompts=0",
      "-p",
      String(h.port),
      "agent-2@127.0.0.1",
      "echo should-never-run",
    ]);
    expect(answer.code).not.toBe(0);
    expect(h.controlPlane.opens).toHaveLength(0);
  }, 30_000);

  // A refused session-open is the most common way a real user meets this
  // service (per-agent cap reached, access revoked, agent deleted). The
  // reason MUST reach their terminal: severing the connection in the same
  // tick as the notice loses it, and the client then prints a bare
  // "Received disconnect ... :11:" with an empty description — indistinguishable
  // from a crash or a network fault. Found on the dev live gate.
  it("tells the client WHY session-open was refused (no PTY)", async () => {
    const h = await openHarness({
      openDelayMs: 250,
      openRefusal: {
        status: 409,
        message: "too many concurrent sessions for this agent",
      },
    });
    await mintClientCert(h.ca);
    const answer = await runCli("ssh", [
      // -n (stdin from /dev/null) is what every scripted caller, scp, sftp
      // and VS Code Remote probe effectively does — and it is the case that
      // loses the notice.
      "-n",
      ...clientOpts(),
      "-p",
      String(h.port),
      "agent-1@127.0.0.1",
      "echo should-never-run",
    ]);
    expect(answer.code).not.toBe(0);
    expect(answer.stdout).not.toContain("should-never-run");
    expect(h.controlPlane.opens).toHaveLength(1);
    expect(h.broker.opens).toHaveLength(0);
    expect(answer.stderr).toContain(
      "too many concurrent sessions for this agent",
    );
  }, 30_000);

  it("tells the client WHY session-open was refused (PTY)", async () => {
    const h = await openHarness({
      openDelayMs: 250,
      openRefusal: { status: 403, message: "workspace access was revoked" },
    });
    await mintClientCert(h.ca);
    const answer = await runCli("ssh", [
      "-tt",
      ...clientOpts(),
      "-p",
      String(h.port),
      "agent-1@127.0.0.1",
      "echo should-never-run",
    ]);
    expect(answer.code).not.toBe(0);
    expect(answer.stdout).not.toContain("should-never-run");
    expect(`${answer.stdout}${answer.stderr}`).toContain(
      "workspace access was revoked",
    );
  }, 30_000);

  // The heartbeat status law, end to end: infrastructure noise between the
  // terminator and the control plane (a WAF 403 on the public path, an
  // api-server deploy window) must NOT read as a revocation. Below the strike
  // ceiling the session rides it out; sustained, it closes with the honest
  // "control plane unreachable" — never the "your access was revoked" lie.
  it("rides out transient heartbeat 403s below the strike ceiling", async () => {
    const h = await openHarness({
      wakingAnswers: 0,
      // Two blocked beats (the attach beat + one interval), then clean —
      // one short of HEARTBEAT_STRIKES.
      heartbeatStatuses: [403, 403],
    });
    await mintClientCert(h.ca);
    const answer = await runCli("ssh", [
      "-tt",
      ...clientOpts(),
      "-p",
      String(h.port),
      "agent-1@127.0.0.1",
      "sleep 3.5 && echo rode-it-out",
    ]);
    expect(answer.code).toBe(0);
    expect(answer.stdout).toContain("rode-it-out");
    expect(answer.stdout).not.toContain("your access was revoked");
    await vi.waitFor(() => {
      expect(h.controlPlane.closes).toEqual([
        { sessionId: SESSION_ID, reason: "client_disconnect" },
      ]);
    });
  }, 30_000);

  it("closes as control-plane-unreachable (never revoked) under sustained heartbeat failures", async () => {
    const h = await openHarness({
      wakingAnswers: 0,
      heartbeatStatuses: Array.from({ length: 30 }, () => 403),
    });
    await mintClientCert(h.ca);
    const answer = await runCli("ssh", [
      "-tt",
      ...clientOpts(),
      "-p",
      String(h.port),
      "agent-1@127.0.0.1",
      "sleep 10 && echo should-never-finish",
    ]);
    expect(answer.stdout).not.toContain("should-never-finish");
    expect(answer.stdout).toContain("control plane unreachable");
    expect(answer.stdout).not.toContain("your access was revoked");
    await vi.waitFor(() => {
      expect(h.controlPlane.closes).toEqual([
        { sessionId: SESSION_ID, reason: "control_plane_unreachable" },
      ]);
    });
  }, 30_000);

  it("hint-free-drops connections past the pre-auth rate limit", async () => {
    const h = await openHarness({ preauthPerIpPerMinute: 1, wakingAnswers: 0 });
    await mintClientCert(h.ca);
    const first = await runCli("ssh", [
      ...clientOpts(),
      "-p",
      String(h.port),
      "agent-1@127.0.0.1",
      "echo first",
    ]);
    expect(first.code).toBe(0);
    const second = await runCli("ssh", [
      ...clientOpts(),
      "-o",
      "ConnectionAttempts=1",
      "-p",
      String(h.port),
      "agent-1@127.0.0.1",
      "echo second",
    ]);
    expect(second.code).not.toBe(0);
    expect(second.stdout).not.toContain("second");
  }, 30_000);

  describe.skipIf(!localSftpServer)("sftp", () => {
    it("round-trips a file through the raw-channel sftp relay", async () => {
      const workDir = mkdtempSync(join(tmpdir(), "term-e2e-sftp-"));
      const h = await openHarness({ workDir, wakingAnswers: 0 });
      await mintClientCert(h.ca);

      const localDir = mkdtempSync(join(tmpdir(), "term-e2e-local-"));
      const uploadPath = join(localDir, "payload.bin");
      const downloadPath = join(localDir, "roundtrip.bin");
      const payload = Buffer.from(`sftp-e2e-${Date.now()}-${"x".repeat(4096)}`);
      writeFileSync(uploadPath, payload);
      const batchPath = join(localDir, "batch.txt");
      writeFileSync(
        batchPath,
        `put ${uploadPath} uploaded.bin\nget uploaded.bin ${downloadPath}\n`,
      );

      const answer = await runCli("sftp", [
        "-b",
        batchPath,
        ...clientOpts(),
        "-P",
        String(h.port),
        "agent-1@127.0.0.1",
      ]);
      expect(answer.code).toBe(0);
      // The put landed in the guest landing dir (the harness work dir) and
      // came back byte-identical.
      expect(readFileSync(join(workDir, "uploaded.bin"))).toEqual(payload);
      expect(readFileSync(downloadPath)).toEqual(payload);
    }, 30_000);
  });
});
