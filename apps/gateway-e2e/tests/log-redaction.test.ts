import { createServer } from "node:net";

import { describe, expect } from "vitest";

import type { WorldSpec } from "../src/fixtures.js";
import { throughMitm } from "../src/mitm.js";
import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";
import { websocketUpgrade } from "../src/websocket.js";

/**
 * Credentials in a request's query string never reach the gateway's logs.
 *
 * Some providers authenticate with the query (SharePoint `tempauth`, Facebook
 * `access_token`, Google and Trello `key`, presigned S3/Azure signatures), and
 * the gateway injects query credentials itself (a secret's `paramName`). The
 * gateway logs request URLs, so each line must show the masked query while the
 * request that reaches the provider keeps the real one.
 *
 * Asserted on what the real binary writes, never on a log-line helper: a new
 * log line that bypassed the masking would fail here.
 */

const AGENT_SECRET = "agent-query-secret-e2e";
const INJECTED_SECRET = "sk-e2e-injected-query-value";

/** A secret the gateway injects into the query of every request to the stub. */
const QUERY_SECRET_WORLD: WorldSpec = {
  grantAll: true,
  secrets: [
    { hostPattern: "127.0.0.1", paramName: "api_key", value: INJECTED_SECRET },
  ],
};

/** A 127.0.0.1 port nothing listens on: bound, read, released. */
const closedPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
};

describe("query credentials in logs", () => {
  scenario(
    "an agent's query credential reaches the upstream but is masked in the log",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed();
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        url: upstream.url(
          `/upload?guid=a1&tempauth=${AGENT_SECRET}&access_token=${AGENT_SECRET}`,
        ),
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(200);
      // Masking is for log lines only: the provider gets the real query.
      const [seen] = await upstream.waitForRequests(1);
      expect(seen?.url).toBe(
        `/upload?guid=a1&tempauth=${AGENT_SECRET}&access_token=${AGENT_SECRET}`,
      );

      await gw.waitForLog("MITM");
      const logs = gw.logs();
      expect(logs).toContain("/upload?guid=a1&tempauth=***&access_token=***");
      expect(logs).not.toContain(AGENT_SECRET);
    },
  );

  scenario(
    "a credential the gateway injects into the query is not logged when the send fails",
    async (cx) => {
      await cx.seed(QUERY_SECRET_WORLD);
      const gw = await cx.startGateway();

      // reqwest names the URL it failed to reach in its error, and that URL
      // carries the injected credential; the gateway logs the error.
      const res = await throughMitm(gw.origin, {
        authority: `127.0.0.1:${String(await closedPort())}`,
        path: "/v1/models?limit=5",
        token: cx.ids.agentToken,
        caPath: gw.caPath,
      });

      expect(res.status).toBe(502);
      expect(res.json()).toMatchObject({ error: "upstream_unreachable" });
      await gw.waitForLog("request forwarding failed");
      const logs = gw.logs();
      expect(logs).toContain("/v1/models?limit=5");
      expect(logs).not.toContain(INJECTED_SECRET);
    },
  );

  scenario(
    "the same injected credential is not logged when an HTTP-proxy send fails",
    async (cx) => {
      await cx.seed(QUERY_SECRET_WORLD);
      const gw = await cx.startGateway();

      // Absolute-form proxying is the other lane: its forwarding error is
      // logged by the server's connection handler instead of mitm.rs, which
      // drops the client connection.
      await expect(
        throughProxy(gw.origin, {
          url: `http://127.0.0.1:${String(await closedPort())}/v1/models?limit=5`,
          token: cx.ids.agentToken,
        }),
      ).rejects.toThrow();

      await gw.waitForLog("connection error");
      const logs = gw.logs();
      expect(logs).toContain("/v1/models?limit=5");
      expect(logs).not.toContain(INJECTED_SECRET);
    },
  );

  scenario(
    "a WebSocket upgrade's query token is masked in the log",
    async (cx) => {
      const upstream = await cx.upstreamWs();
      await cx.seed();
      const gw = await cx.startGateway();

      const res = await websocketUpgrade(gw.origin, {
        authority: upstream.authority,
        path: `/socket?room=general&access_token=${AGENT_SECRET}`,
        token: cx.ids.agentToken,
        caPath: gw.caPath,
      });

      expect(res.status).toBe(101);
      const [seen] = await upstream.waitForUpgrades(1);
      expect(seen?.url).toBe(
        `/socket?room=general&access_token=${AGENT_SECRET}`,
      );

      await gw.waitForLog("WebSocket upgrade");
      const logs = gw.logs();
      expect(logs).toContain("/socket?room=general&access_token=***");
      expect(logs).not.toContain(AGENT_SECRET);
    },
  );
});
