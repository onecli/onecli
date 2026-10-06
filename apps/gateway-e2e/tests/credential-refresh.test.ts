import { cryptoService } from "@onecli/api/lib/crypto";
import type { PrismaClient } from "@prisma/client";
import { describe, expect } from "vitest";

import { startForwardProxy } from "../src/forward-proxy.js";
import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * Credential refreshes that spend no single-use token, end to end through the
 * real binary.
 *
 * A client-credentials connection (MongoDB Atlas) re-mints its access token
 * from a long-lived client id and secret. Its token URL is stored in the
 * connection itself, so unlike an OAuth refresh (whose token endpoint is a
 * fixed provider host) it can point at a local stub: the refresh genuinely
 * succeeds and its write to the database is observable.
 *
 * The agent's own request goes to the real provider host, so the gateway runs
 * with `HTTP_PROXY` at a recording forward proxy (nothing leaves the machine)
 * and `NO_PROXY` exempting the local token stub.
 */

const ATLAS_URL = "http://cloud.mongodb.com/api/atlas/v2/groups";

const expiredAtlas = (tokenUrl: string) => ({
  grantAll: true,
  appConnections: [
    {
      provider: "mongodb-atlas",
      label: "atlas-e2e",
      credentials: {
        type: "client_credentials",
        access_token: "atlas-stale",
        // Long expired: the first request must re-mint.
        expires_at: 1,
        client_id: "e2e-atlas-client",
        client_secret: "e2e-atlas-secret",
        token_url: tokenUrl,
      },
    },
  ],
});

/** The connection's stored credentials, decrypted, as the gateway would read them. */
const storedCredentials = async (
  prisma: PrismaClient,
  id: string,
): Promise<unknown> => {
  const row = await prisma.appConnection.findUniqueOrThrow({ where: { id } });
  if (row.credentials === null) {
    throw new Error("connection has no credentials");
  }
  return JSON.parse(await cryptoService.decrypt(row.credentials));
};

describe("non-OAuth credential refresh", () => {
  scenario("stores a re-minted client-credentials token", async (cx) => {
    const tokens = await cx.upstream();
    tokens.respond({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: "atlas-fresh", expires_in: 3600 }),
    });
    await cx.seed(expiredAtlas(tokens.url("/token")));
    const connectionId = `${cx.ids.workspace}-conn-0`;
    const proxy = await startForwardProxy();

    try {
      const gw = await cx.startGateway({
        env: {
          HTTP_PROXY: proxy.url,
          HTTPS_PROXY: proxy.url,
          NO_PROXY: "127.0.0.1",
        },
      });

      const res = await throughProxy(gw.origin, {
        url: ATLAS_URL,
        token: cx.ids.agentToken,
        timeoutMs: 30_000,
      });
      expect(res.status).toBe(200);

      expect(tokens.requests()).toHaveLength(1);
      expect(proxy.requests()[0]?.header("authorization")).toBe(
        "Bearer atlas-fresh",
      );
      // The compare-and-set write lands when nothing else changed the row.
      expect(await storedCredentials(cx.db.prisma, connectionId)).toMatchObject(
        {
          access_token: "atlas-fresh",
          client_secret: "e2e-atlas-secret",
        },
      );
    } finally {
      await proxy.close();
    }
  });

  scenario(
    "never overwrites a reconnect that landed during the re-mint",
    async (cx) => {
      const tokens = await cx.upstream();
      // Held long enough for the reconnect below to land while the gateway's
      // token request is genuinely in flight.
      tokens.respond({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_token: "atlas-fresh", expires_in: 3600 }),
        delayMs: 1_500,
      });
      await cx.seed(expiredAtlas(tokens.url("/token")));
      const connectionId = `${cx.ids.workspace}-conn-0`;
      const proxy = await startForwardProxy();

      try {
        const gw = await cx.startGateway({
          env: {
            HTTP_PROXY: proxy.url,
            HTTPS_PROXY: proxy.url,
            NO_PROXY: "127.0.0.1",
          },
        });

        const inFlight = throughProxy(gw.origin, {
          url: ATLAS_URL,
          token: cx.ids.agentToken,
          timeoutMs: 30_000,
        });
        await tokens.waitForRequests(1);

        // The user reconnects with a different client while the gateway's
        // re-mint is out.
        const reconnected = {
          type: "client_credentials",
          access_token: "atlas-reconnected",
          expires_at: 4_102_444_800,
          client_id: "e2e-atlas-client-2",
          client_secret: "e2e-atlas-secret-2",
          token_url: tokens.url("/token"),
        };
        await cx.db.prisma.appConnection.update({
          where: { id: connectionId },
          data: {
            credentials: await cryptoService.encrypt(
              JSON.stringify(reconnected),
            ),
          },
        });

        expect((await inFlight).status).toBe(200);
        // The request that started the re-mint still uses what it minted...
        expect(proxy.requests()[0]?.header("authorization")).toBe(
          "Bearer atlas-fresh",
        );
        // ...but the write yields: the reconnect survives intact. A plain
        // overwrite would have put the old client's secret back.
        expect(await storedCredentials(cx.db.prisma, connectionId)).toEqual(
          reconnected,
        );
      } finally {
        await proxy.close();
      }
    },
  );
});

/**
 * Dropbox enforces a folder scope per request (a request guard), so a folder
 * policy needs no freshly minted token: the stored one is the right
 * credential. Its OAuth refresh token is therefore spent only on a real
 * expiry, never just because a policy is present.
 */
describe("dropbox with a folder scope", () => {
  scenario(
    "injects the stored token without spending the refresh token",
    async (cx) => {
      await cx.seed({
        appConnections: [
          {
            provider: "dropbox",
            label: "dropbox-e2e",
            credentials: {
              access_token: "dropbox-live",
              refresh_token: "dropbox-rt-0",
              token_type: "Bearer",
              // Valid for decades: no refresh is due.
              expires_at: 4_102_444_800,
            },
          },
        ],
        rules: [
          {
            name: "grant: agent → dropbox",
            action: "allow",
            source: "grant",
            priority: 90,
            identities: ["agent"],
            targets: [{ kind: "connection", connectionIndex: 0 }],
            resources: { folders: ["/Marketing"] },
          },
        ],
      });
      const proxy = await startForwardProxy();

      try {
        const gw = await cx.startGateway({
          env: {
            HTTP_PROXY: proxy.url,
            HTTPS_PROXY: proxy.url,
            // Configured, so a refresh would really be attempted if the
            // gateway decided to spend the token.
            DROPBOX_CLIENT_ID: "e2e-client",
            DROPBOX_CLIENT_SECRET: "e2e-secret",
          },
        });

        for (let i = 0; i < 2; i++) {
          const res = await throughProxy(gw.origin, {
            method: "POST",
            url: "http://api.dropboxapi.com/2/files/list_folder",
            token: cx.ids.agentToken,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: "/Marketing" }),
            timeoutMs: 30_000,
          });
          expect(res.status).toBe(200);
        }

        // No token exchange reached the provider host...
        expect(proxy.connects()).toEqual([]);
        // ...and both requests carried the stored token.
        const injected = proxy.requests().map((r) => r.header("authorization"));
        expect(injected).toEqual([
          "Bearer dropbox-live",
          "Bearer dropbox-live",
        ]);
      } finally {
        await proxy.close();
      }
    },
  );
});
