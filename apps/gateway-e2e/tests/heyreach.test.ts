import { describe, expect } from "vitest";

import { decideApproval, waitForApproval } from "../src/control.js";
import { startForwardProxy } from "../src/forward-proxy.js";
import { startHeldRequest, throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * HeyReach through the real binary. Its public API and its own web app's
 * backend share one host (`api.heyreach.io`), so the key may only ride the
 * documented `/api/public/` paths: as `X-API-KEY`, never as Authorization,
 * and never on the web app's paths. As in dripify.test.ts, the gateway's
 * outbound client goes through a local recording proxy, so nothing leaves
 * the machine and the injected headers are read off the wire.
 */
const CREDENTIALS = {
  // As the connect handler stores them: `access_token` is the trimmed key,
  // `apiKey` the raw form field (with the trailing newline a paste can
  // carry). Only the trimmed one may go out.
  access_token: "hr-key",
  apiKey: "hr-key\n",
};

describe("heyreach", () => {
  scenario(
    "injects the key as X-API-KEY on the public API only",
    async (cx) => {
      await cx.seed({
        grantAll: true,
        appConnections: [
          {
            provider: "heyreach",
            label: "heyreach-e2e",
            credentials: CREDENTIALS,
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
          "http://api.heyreach.io/api/public/auth/CheckApiKey",
          "http://api.heyreach.io/api/public/campaign/GetById?campaignId=7",
        ];
        // HeyReach's own web app backend, on the same host.
        const unkeyed = [
          "http://api.heyreach.io/UserConfiguration/GetAllExtended",
          "http://api.heyreach.io/api/TokenAuth/Authenticate",
          "http://api.heyreach.io/api/publicx/campaign/GetAll",
        ];
        for (const url of [...keyed, ...unkeyed]) {
          expect(await send(url), url).toBe(200);
        }

        // Every request reached the recorder, so an absent header below is
        // the gateway's decision, not a request that never went out.
        const seen = proxy.requests();
        expect(seen.map((r) => r.url)).toEqual([...keyed, ...unkeyed]);
        for (const req of seen.slice(0, keyed.length)) {
          expect(req.header("x-api-key"), req.url).toBe("hr-key");
          expect(req.header("authorization"), req.url).toBeUndefined();
        }
        for (const req of seen.slice(keyed.length)) {
          expect(req.header("x-api-key"), req.url).toBeUndefined();
          expect(req.header("authorization"), req.url).toBeUndefined();
        }
      } finally {
        await proxy.close();
      }
    },
  );

  // Hermetic: plain http, so the gateway makes no name read and the cards
  // keep their ids (the reads are unit-tested in `proxy::approval_enrich`).
  // Every held request is DENIED, so nothing egresses.
  scenario("a held write reads as what it does", async (cx) => {
    await cx.seed({
      withApiKey: true,
      appConnections: [{ provider: "heyreach", credentials: CREDENTIALS }],
      rules: [
        {
          name: "heyreach writes need approval",
          action: "allow" as const,
          requireApproval: true,
          source: "grant" as const,
          priority: 1,
          identities: ["agent"] as const,
          targets: [
            {
              kind: "connection" as const,
              connectionIndex: 0,
              tools: ["add_leads_to_campaign", "send_message"],
            },
          ],
        },
      ],
    });
    const gw = await cx.startGateway();

    const cases = [
      {
        url: "http://api.heyreach.io/api/public/campaign/AddLeadsToCampaignV2",
        body: {
          campaignId: 235,
          accountLeadPairs: [
            {
              linkedInAccountId: 123,
              lead: {
                firstName: "John",
                lastName: "Doe",
                profileUrl: "https://www.linkedin.com/in/john-doe",
              },
            },
          ],
          resumePausedCampaign: true,
        },
        // Plain http makes no name read: the campaign keeps its id.
        action: "Add leads to campaign 235",
        rows: { Campaign: "Campaign · 235", Who: "John Doe" },
      },
      {
        url: "http://api.heyreach.io/api/public/inbox/SendMessage",
        body: {
          message: "Hi Jane, following up on our call.",
          subject: "",
          conversationId: "2-ODM0",
          linkedInAccountId: 123,
        },
        action: "Send a LinkedIn message",
        rows: { Message: "Hi Jane, following up on our call." },
      },
    ];

    // The headline and a row or two: each card's full rows are pinned by
    // the `summary::heyreach` unit tests. What only the wire shows is that
    // HeyReach's summarizer runs for its host on the approval path, and
    // that the key never rides along.
    for (const c of cases) {
      const held = await startHeldRequest(
        gw.origin,
        {
          method: "POST",
          url: c.url,
          token: cx.ids.agentToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(c.body),
        },
        300,
      );
      const row = await waitForApproval(gw, cx.ids.apiKey);
      expect(row.summary?.action, c.url).toBe(c.action);
      const details = Object.fromEntries(
        (row.summary?.details ?? []).map((d) => [d.label, d.value]),
      );
      expect(details, c.url).toMatchObject(c.rows);
      expect(JSON.stringify(row), c.url).not.toContain("hr-key");

      await decideApproval(gw, cx.ids.apiKey, row.id, "deny");
      expect((await held.response).status).toBe(403);
    }
  });
});
