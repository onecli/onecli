import { rmSync } from "node:fs";

import { test } from "vitest";

import { createTestDatabase, type TestDatabase } from "./db.js";
import { e2eConfig, type E2EConfig } from "./env.js";
import { seedWorld, type WorldSpec } from "./fixtures.js";
import {
  startGateway,
  type GatewayHandle,
  type GatewayOptions,
} from "./gateway.js";
import { newTestIds, type TestIds } from "./ids.js";
import {
  startStubUpstream,
  type StubUpstream,
  type WebSocketStubUpstream,
} from "./upstream.js";

/** What a scenario body is handed. */
export interface Cx {
  readonly ids: TestIds;
  readonly db: TestDatabase;
  readonly config: E2EConfig;
  /** Seed this test's fixtures. Ids always come from `ids`, never the caller. */
  seed(spec?: WorldSpec): Promise<void>;
  /** A stub origin server on 127.0.0.1. Closed automatically. */
  upstream(): Promise<StubUpstream>;
  /** An HTTPS stub — required by the MITM path, which always dials over TLS. */
  upstreamTls(): Promise<StubUpstream>;
  /** An HTTPS stub that also accepts WebSocket upgrades. */
  upstreamWs(): Promise<WebSocketStubUpstream>;
  /** Start a gateway against this test's database. Stopped automatically. */
  startGateway(
    options?: Omit<GatewayOptions, "databaseUrl" | "config">,
  ): Promise<GatewayHandle>;
}

/**
 * The suite's single entry point.
 *
 * Centralising setup and teardown here means the skip guard, the fixture
 * lifecycle and the on-failure diagnostics are written once rather than
 * copy-pasted per test — which is exactly how the suite this replaces ended up
 * with the same ten-line skip preamble duplicated eight times, and all eight
 * silently disabled.
 */
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
    const started: GatewayHandle[] = [];
    const upstreams: StubUpstream[] = [];

    const cx: Cx = {
      ids,
      db,
      config,
      seed: (spec) => seedWorld(db.prisma, ids, spec),
      upstream: async () => {
        const stub = await startStubUpstream();
        upstreams.push(stub);
        return stub;
      },
      upstreamTls: async () => {
        const stub = await startStubUpstream({ tls: true });
        upstreams.push(stub);
        return stub;
      },
      upstreamWs: async () => {
        const stub = await startStubUpstream({ tls: true, websocket: true });
        upstreams.push(stub);
        return stub;
      },
      startGateway: async (options) => {
        const handle = await startGateway({
          ...options,
          databaseUrl: db.url,
          config,
        });
        started.push(handle);
        return handle;
      },
    };

    try {
      await body(cx);
    } catch (error) {
      // A black-box failure is unreadable without the child's own account of
      // what happened, so attach it rather than making anyone re-run by hand.
      const logs = started
        .map((g, i) => `--- gateway #${String(i + 1)} ---\n${g.logs()}`)
        .join("\n");
      if (logs !== "") {
        const detail = error instanceof Error ? error.message : String(error);
        // Keep the original as `cause` so the real stack is not lost.
        throw new Error(`${detail}\n\n${logs}\n--- database: ${db.name} ---`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      // Two waves, gateways first: a stub's close() calls
      // closeAllConnections(), which would yank sockets out from under a
      // gateway that is still draining and turn every teardown into a storm of
      // upstream resets. allSettled, not all, in both waves: a single
      // rejection would skip everything below it and strand a database — the
      // same shape as the leak this teardown was written to prevent.
      await Promise.allSettled(started.map((g) => g.stop()));
      await Promise.allSettled(upstreams.map((u) => u.close()));
      try {
        // Deduplicated: the CA-persistence test deliberately runs two gateways
        // over one data dir, and it must survive until both have stopped.
        for (const dir of new Set(started.map((g) => g.dataDir))) {
          rmSync(dir, { recursive: true, force: true });
        }
      } finally {
        // The database is the one resource another test can collide with, so
        // it is dropped no matter how the rest of teardown went.
        await db.drop();
      }
    }
  });
};
