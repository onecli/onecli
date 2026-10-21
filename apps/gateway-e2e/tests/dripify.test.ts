import { describe, expect } from "vitest";

import { startForwardProxy } from "../src/forward-proxy.js";
import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * Dripify through the real binary: the key leaves the gateway as an
 * `X-Api-Key` header, never as Authorization, on the Open API host and on the
 * hosted MCP server's path of the web app's host, and nowhere else on that
 * host. As in navan.test.ts, the gateway's outbound client goes through a
 * local recording proxy, so nothing leaves the machine and the injected
 * headers are read off the wire.
 */
describe("dripify", () => {
  scenario(
    "injects the key as X-Api-Key on the API and the MCP server only",
    async (cx) => {
      await cx.seed({
        grantAll: true,
        appConnections: [
          {
            provider: "dripify",
            label: "dripify-e2e",
            // As the connect handler stores them: `access_token` is the
            // trimmed key, `apiKey` the raw form field (here with the
            // trailing newline a paste can carry). Only the trimmed one may
            // go out.
            credentials: { access_token: "drip-key", apiKey: "drip-key\n" },
          },
        ],
      });
      const proxy = await startForwardProxy();
      try {
        const gw = await cx.startGateway({
          env: {
            HTTP_PROXY: proxy.url,
            HTTPS_PROXY: proxy.url,
            NO_PROXY: "127.0.0.1",
          },
        });
        const send = async (url: string) =>
          (
            await throughProxy(gw.origin, {
              url,
              token: cx.ids.agentToken,
              timeoutMs: 30_000,
            })
          ).status;
        const keyed = [
          "http://api.dripify.com/v1/open-api/campaigns",
          "http://app.dripify.com/api/v1/mcp",
        ];
        const unkeyed = [
          "http://app.dripify.com/",
          "http://app.dripify.com/api/v1/campaigns",
        ];
        for (const url of [...keyed, ...unkeyed]) {
          expect(await send(url), url).toBe(200);
        }

        // Every request reached the recorder, so an absent header below is
        // the gateway's decision, not a request that never went out.
        const seen = proxy.requests();
        expect(seen.map((r) => r.url)).toEqual([...keyed, ...unkeyed]);
        for (const req of seen.slice(0, keyed.length)) {
          expect(req.header("x-api-key"), req.url).toBe("drip-key");
          expect(req.header("authorization"), req.url).toBeUndefined();
        }
        for (const req of seen.slice(keyed.length)) {
          expect(req.header("x-api-key"), req.url).toBeUndefined();
        }
      } finally {
        await proxy.close();
      }
    },
  );

  // The MCP server shares app.dripify.com with the web app, so its catalog
  // tool is fenced by path alone. Hermetic: every request dies at the policy
  // engine, and the `rule_name` shows which rule's reach it fell into.
  scenario(
    "an mcp_access rule decides the MCP path, a whole-app rule both hosts",
    async (cx) => {
      await cx.seed({
        grantAll: true,
        appConnections: [{ provider: "dripify" }],
        rules: [
          {
            name: "block-mcp",
            action: "block" as const,
            targets: [
              {
                kind: "app" as const,
                provider: "dripify",
                tools: ["mcp_access"],
              },
            ],
          },
          {
            name: "backstop",
            action: "block" as const,
            targets: [{ kind: "app" as const, provider: "dripify" }],
          },
        ],
      });
      const gw = await cx.startGateway();
      const expectBlockedBy = async (
        method: string,
        url: string,
        ruleName: string,
      ) => {
        const res = await throughProxy(gw.origin, {
          url,
          token: cx.ids.agentToken,
          method,
        });
        expect(res.status, `${method} ${url}`).toBe(403);
        expect(res.json(), `${method} ${url}`).toMatchObject({
          error: "blocked_by_policy",
          rule_name: ruleName,
        });
      };

      // MCP, with and without the trailing slash, POST and GET.
      for (const [method, url] of [
        ["POST", "http://app.dripify.com/api/v1/mcp"],
        ["POST", "http://app.dripify.com/api/v1/mcp/"],
        ["GET", "http://app.dripify.com/api/v1/mcp"],
      ] as const) {
        await expectBlockedBy(method, url, "block-mcp");
      }
      // The Open API: the whole-app backstop decided, not the MCP tool rule.
      await expectBlockedBy(
        "POST",
        "http://api.dripify.com/v1/open-api/tags",
        "backstop",
      );
    },
  );
});
