import { cryptoService } from "@onecli/api/lib/crypto";
import { describe, expect } from "vitest";

import { startForwardProxy } from "../src/forward-proxy.js";
import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * OAuth token refresh across gateway instances.
 *
 * GitLab (like Atlassian and Notion) rotates refresh tokens: each one is good
 * for exactly one exchange, and GitLab invalidates it the moment it is spent.
 * Every gateway instance sharing a database sees an access token expire at the
 * same moment, so before the refresh was serialized, a request on each of two
 * instances each presented the same refresh token. The second exchange was
 * refused, and the connection died until the user re-authorized.
 *
 * The provider's token endpoint is a real host (`gitlab.com`) that no test can
 * redirect, so the gateways run with `HTTPS_PROXY`/`HTTP_PROXY` pointed at a
 * recording forward proxy: each refresh attempt shows up as a
 * `CONNECT gitlab.com:443` (refused, so nothing leaves the machine), and each
 * forwarded request arrives with the credential the gateway injected. Using
 * plain `http://gitlab.com` for the agent's request keeps the injected header
 * readable at the proxy.
 *
 * While the one permitted refresh is in flight, the proxy stores freshly
 * rotated credentials in the row: what that refresh would have persisted had
 * it been allowed out. Serialization is then observable from the outside:
 * exactly one CONNECT, and every request that queued behind it (on either
 * gateway) carrying the stored token. The spender itself, whose provider call
 * the proxy refuses, falls back to the token it came in with, as a failed
 * refresh always has. Without the lock and the re-read under it, every
 * concurrent request spends the refresh token on its own.
 */
const EXPIRED_GITLAB = {
  grantAll: true,
  appConnections: [
    {
      provider: "gitlab",
      label: "gitlab-e2e",
      credentials: {
        access_token: "e2e-gitlab-stale",
        refresh_token: "e2e-gitlab-rt-0",
        token_type: "Bearer",
        // Long expired: the first request on each instance must refresh.
        expires_at: 1,
      },
    },
  ],
};

const ROTATED = {
  access_token: "e2e-gitlab-rotated",
  refresh_token: "e2e-gitlab-rt-1",
  token_type: "Bearer",
  expires_at: 4_102_444_800,
};

/**
 * The serialization lives in Postgres, so it must hold with or without the
 * shared Redis cache: the licensed lane (the suite default, Redis-backed
 * stores) and a plain self-host with per-process in-memory caches.
 */
const LANES = [
  { name: "with the shared Redis cache", env: {} },
  {
    name: "with in-memory caches and no Redis",
    env: { ENTERPRISE_ENABLED: "", REDIS_HOST: "" },
  },
] as const;

describe("oauth refresh across instances", () => {
  for (const lane of LANES) {
    scenario(
      `spends a rotating refresh token once across two gateways, ${lane.name}`,
      async (cx) => {
        await cx.seed(EXPIRED_GITLAB);
        const connectionId = `${cx.ids.workspace}-conn-0`;

        const proxy = await startForwardProxy({
          // Long enough that every request below is in flight at the same time
          // as the first refresh, which is the overlap the race needs.
          connectHoldMs: 1_500,
          onConnect: async () => {
            await cx.db.prisma.appConnection.update({
              where: { id: connectionId },
              data: {
                credentials: await cryptoService.encrypt(
                  JSON.stringify(ROTATED),
                ),
              },
            });
          },
        });

        try {
          // Two independent processes on one database: the multi-instance
          // deployment the lock must hold across.
          const env = {
            ...lane.env,
            HTTPS_PROXY: proxy.url,
            HTTP_PROXY: proxy.url,
            // Placeholder client credentials so the refresh reaches the token
            // endpoint at all; the proxy refuses the call before it could matter.
            GITLAB_CLIENT_ID: "e2e-client",
            GITLAB_CLIENT_SECRET: "e2e-secret",
          };
          const gateways = await Promise.all([
            cx.startGateway({ env }),
            cx.startGateway({ env }),
          ]);

          const sent = await Promise.all(
            Array.from({ length: 6 }, (_, i) =>
              throughProxy(gateways[i % 2]?.origin ?? "", {
                url: "http://gitlab.com/api/v4/user",
                token: cx.ids.agentToken,
                timeoutMs: 30_000,
              }),
            ),
          );
          for (const res of sent) expect(res.status).toBe(200);

          const refreshes = proxy
            .connects()
            .filter((authority) => authority === "gitlab.com:443");
          expect(refreshes).toHaveLength(1);

          const injected = proxy
            .requests()
            .filter((r) => r.url.startsWith("http://gitlab.com/"))
            .map((r) => r.header("authorization"));
          expect(injected).toHaveLength(6);
          // Five of six requests queued behind the one spend and served the
          // token it stored; only the spender kept its own.
          const rotated = injected.filter(
            (h) => h === `Bearer ${ROTATED.access_token}`,
          );
          const stale = injected.filter((h) => h === "Bearer e2e-gitlab-stale");
          expect(rotated).toHaveLength(5);
          expect(stale).toHaveLength(1);
        } finally {
          await proxy.close();
        }
      },
    );
  }

  scenario(
    "a shutdown waits for a refresh whose request was abandoned",
    async (cx) => {
      await cx.seed(EXPIRED_GITLAB);
      // The token exchange stays in flight this long. A shutdown that lets the
      // process exit before it settles is a shutdown that can lose a pair the
      // provider has already minted. Longer than every shutdown phase that is
      // not the drain (the bounded pool close also waits on the refresh's open
      // transaction, for up to 2s), so only the drain guard can explain the
      // process outliving it.
      const holdMs = 6_000;
      let connectAt: number | undefined;
      const proxy = await startForwardProxy({
        connectHoldMs: holdMs,
        onConnect: () => {
          connectAt = Date.now();
          return Promise.resolve();
        },
      });

      try {
        const gw = await cx.startGateway({
          env: {
            HTTPS_PROXY: proxy.url,
            HTTP_PROXY: proxy.url,
            GITLAB_CLIENT_ID: "e2e-client",
            GITLAB_CLIENT_SECRET: "e2e-secret",
            // Room for the drain to wait out the whole hold.
            GATEWAY_SHUTDOWN_TIMEOUT_SECS: "20",
          },
        });

        // The agent gives up while the exchange is out, so its connection
        // (and the drain guard that connection holds) is gone.
        await expect(
          throughProxy(gw.origin, {
            url: "http://gitlab.com/api/v4/user",
            token: cx.ids.agentToken,
            timeoutMs: 1_000,
          }),
        ).rejects.toThrow(/timed out/);
        expect(proxy.connects()).toEqual(["gitlab.com:443"]);

        const exit = await gw.terminate({ timeoutMs: 25_000 });
        const exitedAt = Date.now();

        expect(exit.code).toBe(0);
        // Only the detached refresh is left to wait for. It settles when the
        // proxy answers the exchange, so the process must outlive that.
        expect(connectAt).toBeDefined();
        expect(exitedAt - (connectAt ?? exitedAt)).toBeGreaterThanOrEqual(
          holdMs - 200,
        );
      } finally {
        await proxy.close();
      }
    },
  );

  scenario("never spends a token for a disconnected connection", async (cx) => {
    await cx.seed(EXPIRED_GITLAB);
    const proxy = await startForwardProxy();

    try {
      const gw = await cx.startGateway({
        env: {
          HTTPS_PROXY: proxy.url,
          HTTP_PROXY: proxy.url,
          GITLAB_CLIENT_ID: "e2e-client",
          GITLAB_CLIENT_SECRET: "e2e-secret",
        },
      });
      // Resolve once so the connection row is in the gateway's connect cache,
      // then disconnect it. The cached copy still says "connected".
      await throughProxy(gw.origin, {
        url: "http://gitlab.com/api/v4/user",
        token: cx.ids.agentToken,
        timeoutMs: 30_000,
      });
      const before = proxy.connects().length;
      await cx.db.prisma.appConnection.update({
        where: { id: `${cx.ids.workspace}-conn-0` },
        data: { status: "disconnected" },
      });

      await throughProxy(gw.origin, {
        url: "http://gitlab.com/api/v4/user",
        token: cx.ids.agentToken,
        timeoutMs: 30_000,
      });

      // The in-lock re-read sees the disconnect: no refresh, no credential.
      expect(proxy.connects().length).toBe(before);
      const forwarded = proxy.requests();
      expect(forwarded).toHaveLength(2);
      expect(forwarded[1]?.header("authorization")).toBeUndefined();
    } finally {
      await proxy.close();
    }
  });
});
