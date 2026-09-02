import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import { describe, expect } from "vitest";

import { gatewayBinary } from "../src/binary.js";
import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

const execFileAsync = promisify(execFile);

/** Run `onecli-gateway --healthcheck --port <port>` and return its exit code. */
const healthcheckExit = async (port: number): Promise<number> => {
  try {
    await execFileAsync(gatewayBinary(), [
      "--healthcheck",
      "--port",
      String(port),
    ]);
    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? -1;
  }
};

describe("lifecycle", () => {
  scenario("healthz reports ok once the gateway is listening", async (cx) => {
    const gw = await cx.startGateway();

    const res = await fetch(`${gw.origin}/healthz`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  scenario(
    "--healthcheck exits 0 against a live gateway and 1 against a dead port",
    async (cx) => {
      const gw = await cx.startGateway();

      // The image healthchecks (Dockerfile HEALTHCHECK, ECS task def) run
      // exactly this invocation — the exit code is the contract.
      expect(await healthcheckExit(gw.port)).toBe(0);

      await gw.stop();
      expect(await healthcheckExit(gw.port)).toBe(1);
    },
  );

  scenario("an unknown origin-form path falls through to 400", async (cx) => {
    const gw = await cx.startGateway();

    const res = await fetch(`${gw.origin}/not-a-route`);

    expect(res.status).toBe(400);
  });

  scenario("keeps the same CA across a restart", async (cx) => {
    const first = await cx.startGateway();
    const originalCa = readFileSync(first.caPath, "utf8");
    await first.stop();

    // Same data dir: a regenerated CA would break every already-trusting client.
    const second = await cx.startGateway({ dataDir: first.dataDir });

    expect(readFileSync(second.caPath, "utf8")).toBe(originalCa);
    expect(originalCa).toContain("BEGIN CERTIFICATE");
  });

  scenario(
    "answers a managed OpenAI refresh without reaching the network",
    async (cx) => {
      await cx.seed();
      const gw = await cx.startGateway();

      // The gateway short-circuits this before opening any connection, which is
      // why it is testable with no DNS and no egress at all — auth.openai.com is
      // never resolved.
      const res = await throughProxy(gw.origin, {
        method: "POST",
        url: "http://auth.openai.com/oauth/token",
        token: cx.ids.agentToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          refresh_token: "onecli-managed",
          grant_type: "refresh_token",
        }),
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain("onecli-managed");
    },
  );
});
