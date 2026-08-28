import { test } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { e2eConfig, type HostedE2EConfig } from "./env.js";
import { newTestIds, type TestIds } from "./ids.js";
import { createTestDatabase, type TestDatabase } from "./db.js";
import { startGateway, type GatewayHandle } from "./gateway.js";
import { startApiServer, type ApiServerHandle } from "./api-server.js";
import { startTestRunner, type TestRunnerHandle } from "./runner.js";
import { startStubUpstream, type StubUpstream } from "./upstream.js";
import { dockerNetworkRm } from "./docker.js";
import { freePort } from "./ports.js";
import { v1Client, type V1Client } from "./v1.js";

/**
 * The suite's single entry point — the gateway-e2e discipline (one skip
 * guard, one fixture lifecycle, on-failure diagnostics written once) grown
 * to a four-piece topology: per-test clone DB, gateway child, api-server
 * child, in-process runner with real Docker sandboxes.
 *
 * Ordering is load-bearing twice: the GATEWAY starts before the api-server
 * (its port rides `ONECLI_AGENT_PROXY_ADDRESS` in the child env), and
 * teardown runs runner → sandbox reap
 * → children → network → DB drop, with the drop unconditional (the one
 * resource another test can collide with).
 */

export interface StartStackOptions {
  /** Per-scenario api-server timing env (SANDBOX_IDLE_STOP_SECONDS, ...). */
  apiEnv?: Record<string, string>;
  gatewayEnv?: Record<string, string>;
  maxSandboxes?: number;
  /** Skip the runner entirely (the auto-hide posture). */
  withRunner?: boolean;
  orphanGraceSeconds?: number;
  orphanReap?: boolean;
}

export interface Stack {
  gateway: GatewayHandle;
  api: ApiServerHandle;
  runner: TestRunnerHandle | null;
  v1: V1Client;
}

export interface Cx {
  readonly ids: TestIds;
  readonly db: TestDatabase;
  readonly config: HostedE2EConfig;
  readonly prisma: PrismaClient;
  /** Boot the topology (gateway → api → runner unless `withRunner:false`). */
  startStack(options?: StartStackOptions): Promise<Stack>;
  upstreamTls(): Promise<StubUpstream>;
  /** A second /v1 client for the second tenant. */
  v1For(apiOrigin: string, which: "first" | "second"): V1Client;
}

export const scenario = (
  name: string,
  body: (cx: Cx) => Promise<void>,
): void => {
  const config = e2eConfig();
  if (config === null) {
    test.skip(name, () => undefined);
    return;
  }

  test(name, async () => {
    const ids = newTestIds();
    const db = await createTestDatabase(ids, config);
    const gateways: GatewayHandle[] = [];
    const apis: ApiServerHandle[] = [];
    const runners: TestRunnerHandle[] = [];
    const upstreams: StubUpstream[] = [];

    const cx: Cx = {
      ids,
      db,
      config,
      prisma: db.prisma,
      startStack: async (options = {}) => {
        const gateway = await startGateway({
          databaseUrl: db.url,
          ...(options.gatewayEnv && { env: options.gatewayEnv }),
        });
        gateways.push(gateway);
        const api = await startApiServer({
          databaseUrl: db.url,
          gateway,
          runnerToken: ids.runnerToken,
          port: await freePort(),
          config,
          ...(options.apiEnv && { env: options.apiEnv }),
        });
        apis.push(api);
        let runner: TestRunnerHandle | null = null;
        if (options.withRunner !== false) {
          runner = await startTestRunner({
            controlPlaneUrl: api.origin,
            ids,
            config,
            ...(options.maxSandboxes !== undefined && {
              maxSandboxes: options.maxSandboxes,
            }),
            ...(options.orphanGraceSeconds !== undefined && {
              orphanGraceSeconds: options.orphanGraceSeconds,
            }),
            ...(options.orphanReap !== undefined && {
              orphanReap: options.orphanReap,
            }),
          });
          runners.push(runner);
        }
        return {
          gateway,
          api,
          runner,
          v1: v1Client(api.origin, ids.apiKey, ids.workspace),
        };
      },
      upstreamTls: async () => {
        const stub = await startStubUpstream({ tls: true });
        upstreams.push(stub);
        return stub;
      },
      v1For: (apiOrigin, which) =>
        which === "first"
          ? v1Client(apiOrigin, ids.apiKey, ids.workspace)
          : v1Client(apiOrigin, ids.secondApiKey, ids.secondWorkspace),
    };

    try {
      await body(cx);
    } catch (error) {
      const logs = [
        ...gateways.map(
          (g, i) => `--- gateway #${i + 1} ---\n${g.logs.text()}`,
        ),
        ...apis.map(
          (a, i) => `--- api-server #${i + 1} ---\n${a.service.logs.text()}`,
        ),
      ].join("\n");
      if (logs !== "") {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${detail}\n\n${logs}\n--- database: ${db.name} ---`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      // Waves: runner loop first (nothing new spawns), then its sandboxes
      // and homes (runner.stop leaves them by design), then the children,
      // then the per-test network, then — unconditionally — the database.
      await Promise.allSettled(runners.map((r) => r.stop()));
      await Promise.allSettled(runners.map((r) => r.reap()));
      await Promise.allSettled(apis.map((a) => a.stop()));
      await Promise.allSettled(gateways.map((g) => g.stop()));
      await Promise.allSettled(upstreams.map((u) => u.close()));
      try {
        await dockerNetworkRm(ids.network);
      } finally {
        await db.drop();
      }
    }
  });
};
