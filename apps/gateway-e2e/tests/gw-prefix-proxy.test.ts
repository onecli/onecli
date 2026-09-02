import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect } from "vitest";

import { scenario } from "../src/scenario.js";

/**
 * The proxy-mode `/gw` contract, end to end against the real binary.
 *
 * In proxy mode the resolver advertises the gateway's HTTP surface as
 * `<external>/gw` — a PATH-SUFFIXED base the reverse proxy strips before
 * forwarding (`pnpm dev`'s rewrites run the identical contract). Every
 * client that consumes `GET /v1/gateway-url` must compose paths onto that
 * base (`${base}/healthz`), never assume it is a bare origin. This test is
 * the design's gating item: a `/gw`-stripping proxy in front of a spawned
 * gateway, driven base-wise.
 */
const startStrippingProxy = (target: string): Promise<Server> =>
  new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      // The strip: /gw/healthz -> /healthz. A bare /gw becomes /.
      const path = (req.url ?? "/").replace(/^\/gw(?=\/|$)/, "") || "/";
      const upstream = await fetch(`${target}${path}`);
      res.writeHead(
        upstream.status,
        Object.fromEntries(upstream.headers.entries()),
      );
      res.end(Buffer.from(await upstream.arrayBuffer()));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

describe("gateway HTTP behind a /gw prefix-strip proxy", () => {
  scenario("answers base-wise composed paths through the strip", async (cx) => {
    await cx.seed();
    const gw = await cx.startGateway();
    const proxy = await startStrippingProxy(gw.origin);
    try {
      const { port } = proxy.address() as AddressInfo;
      // What a client does with the advertised value: base + path, verbatim.
      const base = `http://127.0.0.1:${port}/gw`;

      const viaProxy = await fetch(`${base}/healthz`);
      expect(viaProxy.status).toBe(200);
      const body = (await viaProxy.json()) as { status: string };
      expect(body.status).toBe("ok");

      // The unstripped path must NOT exist on the gateway itself — proving
      // the strip is load-bearing, not a lucky passthrough.
      const direct = await fetch(`${gw.origin}/gw/healthz`);
      expect(direct.status).not.toBe(200);
    } finally {
      proxy.close();
    }
  });
});
