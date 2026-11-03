import { describe, expect } from "vitest";

import { startForwardProxy } from "../src/forward-proxy.js";
import { throughProxy } from "../src/proxy.js";
import { scenario, type Cx } from "../src/scenario.js";

/**
 * Bitbucket Cloud through the real binary: what an agent's request looks
 * like when it leaves the gateway. As in pagerduty-coralogix-onyx.test.ts, the
 * gateway's outbound client is pointed at a local forward proxy that records
 * the request (nothing leaves the machine), so the injected header is read off
 * the wire.
 *
 * - The REST API (`api.bitbucket.org`) gets the OAuth token as a Bearer.
 * - git over HTTPS (`bitbucket.org`) gets it as Basic `x-token-auth:<token>`,
 *   Bitbucket's documented form for an OAuth access token.
 * - A look-alike host gets nothing.
 */

const TOKEN = "bb-e2e-token";

const withRecorder = async (
  cx: Cx,
  run: (
    send: (url: string, method?: string) => Promise<number>,
    seen: () => ReadonlyArray<{
      url: string;
      header(name: string): string | undefined;
    }>,
  ) => Promise<void>,
): Promise<void> => {
  await cx.seed({
    grantAll: true,
    appConnections: [
      {
        provider: "bitbucket",
        label: "bitbucket-e2e",
        credentials: { access_token: TOKEN },
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
    await run(
      async (url, method) =>
        (
          await throughProxy(gw.origin, {
            url,
            method,
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

describe("bitbucket", () => {
  scenario("the REST API gets the token as a Bearer", async (cx) => {
    await withRecorder(cx, async (send, seen) => {
      expect(
        await send("http://api.bitbucket.org/2.0/repositories/acme/web"),
      ).toBe(200);
      const req = seen()[0];
      expect(req?.url).toBe(
        "http://api.bitbucket.org/2.0/repositories/acme/web",
      );
      expect(req?.header("authorization")).toBe(`Bearer ${TOKEN}`);
    });
  });

  scenario("git over HTTPS signs in as x-token-auth", async (cx) => {
    await withRecorder(cx, async (send, seen) => {
      expect(
        await send(
          "http://bitbucket.org/acme/web.git/info/refs?service=git-upload-pack",
        ),
      ).toBe(200);
      const req = seen()[0];
      expect(req?.header("authorization")).toBe(
        `Basic ${Buffer.from(`x-token-auth:${TOKEN}`).toString("base64")}`,
      );
    });
  });

  scenario("a look-alike host never receives the token", async (cx) => {
    await withRecorder(cx, async (send, seen) => {
      await send("http://evilbitbucket.org/acme/web.git/info/refs");
      // The request did leave the gateway: the assertion below is not vacuous.
      expect(seen().map((req) => req.url)).toEqual([
        "http://evilbitbucket.org/acme/web.git/info/refs",
      ]);
      for (const req of seen()) {
        expect(req.header("authorization")).toBeUndefined();
      }
    });
  });
});
