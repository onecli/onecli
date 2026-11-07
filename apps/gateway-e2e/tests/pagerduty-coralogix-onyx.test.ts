import { describe, expect } from "vitest";

import { startForwardProxy } from "../src/forward-proxy.js";
import { throughMitm } from "../src/mitm.js";
import { throughProxy } from "../src/proxy.js";
import { scenario, type Cx } from "../src/scenario.js";

/**
 * PagerDuty, Coralogix, and Onyx through the real binary: what an agent's
 * request to the documented vendor URL looks like when it leaves the gateway.
 *
 * As in navan.test.ts, the gateway's outbound client is pointed at a local
 * forward proxy that records the request (nothing leaves the machine), so the
 * injected header and the rewritten upstream host are read off the wire.
 *
 * - PagerDuty: the key goes out as `Token token=<key>`, not a Bearer, and an
 *   EU connection's HTTPS request to the US base URL is sent to the EU host.
 * - Coralogix: Bearer, and an HTTPS request to any Coralogix API host
 *   (current or legacy) is sent to the connection's own region.
 * - Onyx: Bearer under `/api/` and `/mcp/` only. The web app on the same host
 *   never receives the key.
 */

const withRecorder = async (
  cx: Cx,
  connection: { provider: string; credentials: Record<string, unknown> },
  run: (
    send: (url: string) => Promise<number>,
    seen: () => ReadonlyArray<{
      url: string;
      header(name: string): string | undefined;
    }>,
  ) => Promise<void>,
): Promise<void> => {
  await cx.seed({
    grantAll: true,
    appConnections: [{ ...connection, label: `${connection.provider}-e2e` }],
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
    await run(
      async (url) =>
        (
          await throughProxy(gw.origin, {
            url,
            token: cx.ids.agentToken,
            timeoutMs: 30_000,
          })
        ).status,
      () => proxy.requests(),
    );
  } finally {
    await proxy.close();
  }
};

/**
 * The region rewrite runs on the MITM (HTTPS) path, which is the path every
 * real agent takes: vendor APIs are HTTPS only. The forward proxy refuses the
 * outbound tunnel, so the only observable is the CONNECT authority, which is
 * exactly where the gateway decided to send the request.
 */
const connectTargetOf = async (
  cx: Cx,
  connection: { provider: string; credentials: Record<string, unknown> },
  authority: string,
  path: string,
): Promise<ReadonlyArray<string>> => {
  await cx.seed({
    grantAll: true,
    appConnections: [{ ...connection, label: `${connection.provider}-e2e` }],
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
    await throughMitm(gw.origin, {
      authority,
      path,
      token: cx.ids.agentToken,
      caPath: gw.caPath,
    }).catch(() => undefined);
    return proxy.connects();
  } finally {
    await proxy.close();
  }
};

describe("pagerduty", () => {
  scenario("injects the key as Token token=, never Bearer", async (cx) => {
    await withRecorder(
      cx,
      {
        provider: "pagerduty",
        credentials: { access_token: "pd-key", region: "us" },
      },
      async (send, seen) => {
        expect(await send("http://api.pagerduty.com/incidents")).toBe(200);
        const req = seen()[0];
        expect(req?.url).toBe("http://api.pagerduty.com/incidents");
        expect(req?.header("authorization")).toBe("Token token=pd-key");
      },
    );
  });

  scenario("an EU connection is sent to the EU host", async (cx) => {
    // The agent calls the documented (US) base URL over HTTPS.
    const targets = await connectTargetOf(
      cx,
      {
        provider: "pagerduty",
        credentials: { access_token: "pd-eu-key", region: "eu" },
      },
      "api.pagerduty.com:443",
      "/oncalls",
    );
    expect(targets).toContain("api.eu.pagerduty.com:443");
    expect(targets).not.toContain("api.pagerduty.com:443");
  });
});

describe("coralogix", () => {
  scenario("injects a Bearer", async (cx) => {
    await withRecorder(
      cx,
      {
        provider: "coralogix",
        credentials: { access_token: "cx-key", region: "us2" },
      },
      async (send, seen) => {
        expect(
          await send("http://api.us2.coralogix.com/api/v1/dataprime/query"),
        ).toBe(200);
        expect(seen()[0]?.header("authorization")).toBe("Bearer cx-key");
      },
    );
  });

  scenario(
    "a call to a legacy host is sent to the connection's region",
    async (cx) => {
      // An existing script still calling the legacy US2 name over HTTPS.
      const targets = await connectTargetOf(
        cx,
        {
          provider: "coralogix",
          credentials: { access_token: "cx-key", region: "us2" },
        },
        "api.cx498.coralogix.com:443",
        "/api/v1/dataprime/query",
      );
      expect(targets).toContain("api.us2.coralogix.com:443");
      expect(targets).not.toContain("api.cx498.coralogix.com:443");
    },
  );

  scenario("a team web app host gets no key", async (cx) => {
    await withRecorder(
      cx,
      {
        provider: "coralogix",
        credentials: { access_token: "cx-key", region: "us2" },
      },
      async (send, seen) => {
        await send("http://acme.app.cx498.coralogix.com/");
        for (const req of seen()) {
          expect(req.header("authorization")).toBeUndefined();
        }
      },
    );
  });
});

describe("onyx", () => {
  scenario("injects a Bearer on the API and the MCP server", async (cx) => {
    await withRecorder(
      cx,
      { provider: "onyx", credentials: { access_token: "onyx-key" } },
      async (send, seen) => {
        expect(await send("http://cloud.onyx.app/api/me")).toBe(200);
        expect(await send("http://cloud.onyx.app/mcp/")).toBe(200);
        const [api, mcp] = seen();
        expect(api?.url).toBe("http://cloud.onyx.app/api/me");
        expect(api?.header("authorization")).toBe("Bearer onyx-key");
        expect(mcp?.header("authorization")).toBe("Bearer onyx-key");
      },
    );
  });

  scenario("the Onyx web app on the same host gets no key", async (cx) => {
    await withRecorder(
      cx,
      { provider: "onyx", credentials: { access_token: "onyx-key" } },
      async (send, seen) => {
        await send("http://cloud.onyx.app/chat");
        await send("http://cloud.onyx.app/apiary");
        for (const req of seen()) {
          expect(req.header("authorization"), req.url).toBeUndefined();
        }
      },
    );
  });
});
