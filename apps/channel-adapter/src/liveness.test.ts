import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Black-box process-liveness proof: the daemon must OUTLIVE its boot sequence.
 *
 * Every in-process unit test is blind to this property — the first live run
 * shipped a `timer.unref()` in the loop sleeps, so the process printed
 * "running" and exited cleanly before its first poll (nothing else held the
 * event loop once registration finished, and signal handlers don't count).
 * This spawns the REAL entrypoint against a stub control plane and asserts
 * the process is still alive after multiple poll intervals, then drains on
 * SIGTERM. Deleting the loops' process-holding behavior fails it again.
 */

const POLL_MS = 120;

const startStubControlPlane = async (): Promise<{
  server: Server;
  url: string;
  polls: () => number;
}> => {
  let polls = 0;
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "";
    const reply = (body: unknown): void => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (path.endsWith("/register")) {
      reply({ adapterId: "adp-liveness" });
      return;
    }
    if (path.endsWith("/config") || path.endsWith("/work")) {
      polls += 1;
      reply(
        path.endsWith("/config")
          ? { presences: [], etag: "liveness-etag" }
          : { finished: [] },
      );
      return;
    }
    if (path.endsWith("/prompts/unsettled")) {
      reply({ prompts: [] });
      return;
    }
    if (path.endsWith("/rotate-integrations")) {
      reply({ rotated: 0, failed: 0 });
      return;
    }
    reply({});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, polls: () => polls };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("daemon process liveness", () => {
  let child: ChildProcess | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (server) {
      server.close();
      server = undefined;
    }
  });

  it("stays alive across idle poll intervals and drains on SIGTERM", async () => {
    const stub = await startStubControlPlane();
    server = stub.server;

    child = spawn("./node_modules/.bin/tsx", ["src/index.ts"], {
      env: {
        ...process.env,
        CHANNEL_ADAPTER_TOKEN: "cha_liveness_test_token",
        CONTROL_PLANE_URL: stub.url,
        GATEWAY_API_URL: stub.url,
        CHANNEL_ADAPTER_CONFIG_POLL_MS: String(POLL_MS),
        CHANNEL_ADAPTER_WORK_POLL_MS: String(POLL_MS),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => {
      child?.on("exit", (code) => resolve(code));
    });

    // Outlast several poll intervals with NO attached work — the regression
    // exited within milliseconds of "running", long before the first poll.
    const deadline = Date.now() + 10_000;
    while (stub.polls() < 3 && Date.now() < deadline) {
      expect(child.exitCode, "daemon exited before its poll loops ran").toBe(
        null,
      );
      await sleep(50);
    }
    expect(stub.polls()).toBeGreaterThanOrEqual(3);
    expect(child.exitCode).toBe(null);

    // And the drain path still exits promptly (bounded by the 3s drain timer).
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  }, 20_000);
});
