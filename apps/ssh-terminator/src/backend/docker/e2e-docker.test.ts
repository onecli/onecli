import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signGrant } from "@onecli/ssh-cert";
import { createConnectionLimits } from "../../limits";
import { createFakeTerminatorMetrics } from "../../metrics";
import { createTerminatorServer, type TerminatorServer } from "../../server";
import {
  createTestCa,
  mintTestCertificate,
  type TestCa,
} from "../../test-fixtures";
import { createControlPlaneClient } from "../../control-plane-client";
import { createDockerBackend } from "./index";

/**
 * End-to-end for the DOCKER substrate: the real terminator server, the real
 * docker resolver + exec-hijack backend against the real local daemon, and
 * the real OpenSSH client dialing in — with only the control plane faked.
 * This is the self-host interop proof: label lookup, exec-as-node, the
 * hijacked stream in both framings, stdin half-close, and exit codes.
 */

const sshAvailable = ((): boolean => {
  const probe = spawnSync("ssh", ["-V"]);
  return probe.error === undefined;
})();

const dockerAvailable = ((): boolean => {
  const probe = spawnSync("docker", ["info"], { timeout: 10_000 });
  return probe.error === undefined && probe.status === 0;
})();

/** node:22-alpine ships the `node` user (uid 1000) the exec pins; the boot
 * script adds bash (the shell payload target) and bridges alpine's
 * sftp-server to the Debian path the shared payload pins. */
const TEST_IMAGE = "node:22-alpine";
const CONTAINER_BOOT =
  "apk add --no-cache bash openssh-sftp-server >/dev/null 2>&1; " +
  "mkdir -p /usr/lib/openssh && " +
  "ln -sf /usr/lib/ssh/sftp-server /usr/lib/openssh/sftp-server; " +
  "sleep 600";

const POLICY = {
  maxSessionSeconds: 600,
  idleTimeoutSeconds: 120,
  heartbeatSeconds: 5,
};

const SESSION_ID = "sess-docker-e2e";

interface CliResult {
  code: number | string;
  stdout: string;
  stderr: string;
}

const runCli = (
  bin: string,
  args: string[],
  stdin?: string,
): Promise<CliResult> =>
  new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { timeout: 20_000 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 255) : 0, stdout, stderr });
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });

const startFakeControlPlane = async (
  ca: TestCa,
  sandboxId: string,
): Promise<{ port: number; close(): Promise<void> }> => {
  const server: HttpServer = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const url = request.url ?? "";
      if (request.method === "POST" && url === "/v1/ssh-terminator/sessions") {
        const grant = await signGrant(
          {
            sessionId: SESSION_ID,
            agentId: "agent-1",
            sandboxId,
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
      if (request.method === "POST" && url.includes("/heartbeat")) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ revoked: false }));
        return;
      }
      if (request.method === "POST" && url.includes("/close")) {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    address !== null && typeof address === "object" ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise((resolve) => server.close(() => resolve(undefined))),
  };
};

// Opt-in, not ambient: this suite pulls node:22-alpine from Docker Hub and
// apk-installs inside a real container in beforeAll, so a transient
// registry/CDN hiccup would THROW (a red suite, not a skip) in the shared
// `pnpm test` CI lane — which runs on ubuntu where both probes pass. Gate it
// behind ONECLI_DOCKER_E2E=1 so CI stays green and it runs on demand
// (`ONECLI_DOCKER_E2E=1 pnpm --filter @onecli/ssh-terminator test`).
const enabled =
  process.env.ONECLI_DOCKER_E2E === "1" && dockerAvailable && sshAvailable;

describe.skipIf(!enabled)(
  "docker substrate e2e (real daemon + OpenSSH)",
  () => {
    const sandboxId = randomUUID();
    const containerName = `onecli-ssh-e2e-${sandboxId.slice(0, 8)}`;
    let server: TerminatorServer;
    let controlPlane: { port: number; close(): Promise<void> };
    let sshPort = 0;
    let clientOpts: string[] = [];
    let fixturesDir = "";

    beforeAll(async () => {
      // The labeled sandbox stand-in — runs as root (so the boot script can
      // apk add), while every exec lands as `node` exactly like production.
      execFileSync("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        containerName,
        "--label",
        "sh.onecli.managed=1",
        "--label",
        `sh.onecli.sandbox-id=${sandboxId}`,
        TEST_IMAGE,
        "sh",
        "-c",
        CONTAINER_BOOT,
      ]);

      const ca = createTestCa();

      // Real OpenSSH key material for the client side.
      fixturesDir = mkdtempSync(join(tmpdir(), "term-docker-e2e-"));
      const hostKeyPath = join(fixturesDir, "host_key");
      execFileSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        hostKeyPath,
      ]);
      const hostKeyPem = readFileSync(hostKeyPath, "utf8");
      const userKeyPath = join(fixturesDir, "user_key");
      execFileSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        userKeyPath,
      ]);
      const userPubLine = readFileSync(`${userKeyPath}.pub`, "utf8").trim();
      const rawUserKey = Buffer.from(userPubLine.split(" ")[1] ?? "", "base64");
      // The blob's last 32 bytes are the raw ed25519 key; the possession
      // proof is the SSH protocol's own signature (the client holds the real
      // private key), so the fixture's sign member is never exercised.
      const built = await mintTestCertificate(
        ca,
        {
          publicKey: rawUserKey.subarray(rawUserKey.length - 32),
          sign: () => Buffer.alloc(0),
        },
        { sandboxId },
      );
      writeFileSync(`${userKeyPath}-cert.pub`, `${built.line}\n`);

      controlPlane = await startFakeControlPlane(ca, sandboxId);

      server = createTerminatorServer({
        hostKey: hostKeyPem,
        caPublicKey: ca.publicKey,
        controlPlane: createControlPlaneClient({
          baseUrl: `http://127.0.0.1:${controlPlane.port}`,
          getSecret: () => "cp-secret",
        }),
        backend: createDockerBackend({
          socketPath: "/var/run/docker.sock",
          caPublicKey: ca.publicKey,
        }),
        metrics: createFakeTerminatorMetrics(),
        limits: createConnectionLimits({
          maxSessions: 8,
          maxSessionsPerIp: 8,
          preauthPerIpPerMinute: 100,
        }),
        wakeWaitSeconds: 10,
        preauthTimeoutSeconds: 5,
        wakePollMs: 100,
      });
      sshPort = await server.listen(0, "127.0.0.1");
      clientOpts = [
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
        "-i",
        userKeyPath,
        "-o",
        `CertificateFile=${userKeyPath}-cert.pub`,
        "-p",
        String(sshPort),
      ];

      // Wait for the container boot script's package install to settle so the
      // bash/sftp arms don't race it.
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const probe = spawnSync("docker", [
          "exec",
          containerName,
          "sh",
          "-c",
          "command -v bash",
        ]);
        if (probe.status === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }, 180_000);

    afterAll(async () => {
      await server?.close();
      await controlPlane?.close();
      spawnSync("docker", ["rm", "-f", containerName]);
    });

    it("execs a command as node in the container (no-tty demux arm)", async () => {
      const result = await runCli("ssh", [
        ...clientOpts,
        "agent-1@127.0.0.1",
        "echo hello-from-$(id -un)",
      ]);
      expect(result.stderr).not.toContain("Permission denied");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("hello-from-node");
    }, 30_000);

    it("propagates the guest exit code", async () => {
      const result = await runCli("ssh", [
        ...clientOpts,
        "agent-1@127.0.0.1",
        "exit 7",
      ]);
      expect(result.code).toBe(7);
    }, 30_000);

    it("routes guest stderr to the client's stderr (demux)", async () => {
      const result = await runCli("ssh", [
        ...clientOpts,
        "agent-1@127.0.0.1",
        "echo to-stderr >&2",
      ]);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("to-stderr");
      expect(result.stdout).not.toContain("to-stderr");
    }, 30_000);

    it("delivers stdin and half-closes cleanly (cat round-trip)", async () => {
      const result = await runCli(
        "ssh",
        [...clientOpts, "agent-1@127.0.0.1", "cat"],
        "stdin-round-trip\n",
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("stdin-round-trip");
    }, 30_000);

    it("runs a PTY session (raw stream arm)", async () => {
      const result = await runCli("ssh", [
        ...clientOpts,
        "-tt",
        "agent-1@127.0.0.1",
        "echo tty-arm-$((20+22))",
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("tty-arm-42");
    }, 30_000);
  },
);
