import { describe, expect } from "vitest";

import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * Timeless's governance surface, end to end through the real binary.
 *
 * Timeless is unusual in that its MCP server lives on the SAME host as its
 * REST API (`api.timeless.day/mcp/`, same token), and the gateway's one host
 * rule injects on every path there. So the MCP server must be its own catalog
 * tool (`mcp_access`) that a tool-scoped rule can reach, with the path alone as
 * the fence: a rule on it must decide `/mcp/` and never a REST path, and a REST
 * tool rule must never reach `/mcp/`.
 *
 * Hermetic despite naming the real provider host: every request dies at the
 * policy engine before any credential is decrypted or any socket is opened.
 * Two different `rule_name`s on the same host are the proof of where each
 * rule's reach ends, asserted without leaving the machine.
 */
const HOST = "api.timeless.day";

describe("timeless governance", () => {
  scenario("a whole-app rule governs REST and MCP alike", async (cx) => {
    await cx.seed({
      grantAll: true,
      appConnections: [{ provider: "timeless" }],
      rules: [
        {
          name: "block-timeless",
          action: "block" as const,
          targets: [{ kind: "app" as const, provider: "timeless" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    for (const path of ["/v1/meetings", "/mcp/"]) {
      const res = await throughProxy(gw.origin, {
        url: `http://${HOST}${path}`,
        token: cx.ids.agentToken,
        method: "POST",
      });
      expect(res.status, path).toBe(403);
      expect(res.json(), path).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "block-timeless",
      });
    }
  });

  scenario(
    "a tool-scoped mcp_access rule decides /mcp/ and nothing else on the host",
    async (cx) => {
      // The load-bearing one. `block-mcp` names only the MCP tool; `backstop`
      // blocks the whole app so a REST request still dies here. The REST path
      // must die on `backstop`, the MCP path on `block-mcp`: the tool's reach
      // is exactly `/mcp/*`, on a host where the REST API also answers.
      await cx.seed({
        grantAll: true,
        appConnections: [{ provider: "timeless" }],
        rules: [
          {
            name: "block-mcp",
            action: "block" as const,
            targets: [
              {
                kind: "app" as const,
                provider: "timeless",
                tools: ["mcp_access"],
              },
            ],
          },
          {
            name: "backstop",
            action: "block" as const,
            targets: [{ kind: "app" as const, provider: "timeless" }],
          },
        ],
      });
      const gw = await cx.startGateway();

      // MCP, with and without the documented trailing slash, POST and GET.
      for (const [method, path] of [
        ["POST", "/mcp/"],
        ["POST", "/mcp"],
        ["GET", "/mcp/"],
      ] as const) {
        const res = await throughProxy(gw.origin, {
          url: `http://${HOST}${path}`,
          token: cx.ids.agentToken,
          method,
        });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.json(), `${method} ${path}`).toMatchObject({
          rule_name: "block-mcp",
        });
      }

      // REST and lookalikes: the backstop decided, NOT the MCP tool rule.
      for (const path of ["/v1/meetings", "/v1/meetings/bot", "/mcpx"]) {
        const res = await throughProxy(gw.origin, {
          url: `http://${HOST}${path}`,
          token: cx.ids.agentToken,
          method: "POST",
        });
        expect(res.status, path).toBe(403);
        expect(res.json(), path).toMatchObject({ rule_name: "backstop" });
      }
    },
  );

  scenario("a REST tool rule does not reach the MCP server", async (cx) => {
    // The other direction: blocking "send the note-taker" must not be what
    // blocks the MCP server, even though the MCP server can do the same thing.
    await cx.seed({
      grantAll: true,
      appConnections: [{ provider: "timeless" }],
      rules: [
        {
          name: "block-send-bot",
          action: "block" as const,
          targets: [
            {
              kind: "app" as const,
              provider: "timeless",
              tools: ["send_bot_to_link"],
            },
          ],
        },
        {
          name: "backstop",
          action: "block" as const,
          targets: [{ kind: "app" as const, provider: "timeless" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const rest = await throughProxy(gw.origin, {
      url: `http://${HOST}/v1/meetings/bot`,
      token: cx.ids.agentToken,
      method: "POST",
    });
    expect(rest.json()).toMatchObject({ rule_name: "block-send-bot" });

    const mcp = await throughProxy(gw.origin, {
      url: `http://${HOST}/mcp/`,
      token: cx.ids.agentToken,
      method: "POST",
    });
    expect(mcp.json()).toMatchObject({ rule_name: "backstop" });
  });
});
