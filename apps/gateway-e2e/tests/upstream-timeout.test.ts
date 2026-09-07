import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

import { describe, expect } from "vitest";

import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * The upstream response-header deadline (issue #493).
 *
 * The forwarding path used to await the upstream send with no bound: an
 * upstream that accepted the request and then never sent response headers left
 * the request pending until the CLIENT gave up, while the gateway looked
 * perfectly healthy. These scenarios pin the two halves of the fix against the
 * real binary:
 *
 *  - a silent upstream now produces a sanitized, non-retryable 504 within the
 *    configured bound, and the request is never re-sent;
 *  - the bound covers only the wait for headers, so a response body that
 *    streams for longer than the bound still arrives whole (the SSE /
 *    long-download guarantee).
 */

/** Accepts TCP, reads the request, never answers. Counts accepts so a replay
 * (which cannot reuse the connection it abandoned) shows up as a second one. */
const silentUpstream = async (): Promise<{
  url: (path: string) => string;
  accepts: () => number;
  close: () => Promise<void>;
}> => {
  let accepts = 0;
  const held: Socket[] = [];
  const server: Server = createServer(() => {
    // Never respond: the handler writing nothing is the failure under test.
  });
  server.on("connection", (socket) => {
    accepts += 1;
    held.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no address");
  const port = address.port;
  return {
    url: (path: string) => `http://127.0.0.1:${String(port)}${path}`,
    accepts: () => accepts,
    close: async () => {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/** Sends headers immediately, then dribbles the body out past the bound. */
const slowBodyUpstream = async (
  chunks: number,
  gapMs: number,
): Promise<{ url: (path: string) => string; close: () => Promise<void> }> => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    let sent = 0;
    const tick = setInterval(() => {
      sent += 1;
      res.write(`chunk${String(sent)};`);
      if (sent >= chunks) {
        clearInterval(tick);
        res.end();
      }
    }, gapMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no address");
  const port = address.port;
  return {
    url: (path: string) => `http://127.0.0.1:${String(port)}${path}`,
    close: async () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("upstream response-header deadline", () => {
  scenario(
    "a silent upstream gets a bounded sanitized 504, never a replay",
    async (cx) => {
      const dead = await silentUpstream();
      await cx.seed();
      const gw = await cx.startGateway({
        env: { GATEWAY_UPSTREAM_HEADER_TIMEOUT_SECS: "2" },
      });

      // A POST: replaying this would be the dangerous case.
      const started = Date.now();
      const res = await throughProxy(gw.origin, {
        method: "POST",
        url: dead.url("/orders"),
        token: cx.ids.agentToken,
        body: '{"charge":true}',
        headers: { "content-type": "application/json" },
        timeoutMs: 15_000,
      });
      const elapsed = Date.now() - started;

      // Bounded: the gateway answered, and only after honoring the deadline.
      expect(res.status).toBe(504);
      expect(elapsed).toBeGreaterThanOrEqual(2_000);
      expect(res.header("x-should-retry")).toBe("false");

      // Sanitized: stable identifier, no URL / transport / credential detail.
      const body = res.json() as { error: string; message: string };
      expect(body.error).toBe("upstream_timeout");
      expect(Object.keys(body).sort()).toEqual(["error", "message"]);
      for (const leak of ["http://", "127.0.0.1", "reqwest", "Bearer"]) {
        expect(res.body).not.toContain(leak);
      }

      // Never replayed: the timed-out POST reached the upstream exactly once.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(dead.accepts()).toBe(1);

      await dead.close();
    },
  );

  scenario(
    "a body streaming far past the header bound still arrives whole",
    async (cx) => {
      // Headers arrive immediately; the body then takes ~5s against a 2s
      // header bound. A total deadline would cut this off — the header-only
      // deadline must not.
      const slow = await slowBodyUpstream(10, 500);
      await cx.seed();
      const gw = await cx.startGateway({
        env: { GATEWAY_UPSTREAM_HEADER_TIMEOUT_SECS: "2" },
      });

      const started = Date.now();
      const res = await throughProxy(gw.origin, {
        url: slow.url("/download"),
        token: cx.ids.agentToken,
        timeoutMs: 30_000,
      });
      const elapsed = Date.now() - started;

      expect(res.status).toBe(200);
      expect((res.body.match(/chunk/g) ?? []).length).toBe(10);
      expect(elapsed).toBeGreaterThan(4_000);

      await slow.close();
    },
  );
});
