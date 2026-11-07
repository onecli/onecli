import { describe, expect } from "vitest";

import { startForwardProxy } from "../src/forward-proxy.js";
import { GATEWAY_APP_URL } from "../src/gateway.js";
import { throughProxy, type ProxyResponse } from "../src/proxy.js";
import { scenario, type Cx } from "../src/scenario.js";
import type { WorldSpec } from "../src/fixtures.js";

/**
 * An app account that exists but is off for this agent, end to end through
 * the real binary: the agent's uncredentialed call fails auth upstream, and
 * the gateway answers `access_restricted` with the switch that turns the
 * existing account on (`manage_url`) and today's connect link as the
 * alternative (`connect_url`), instead of telling it to connect the app.
 *
 * Hermetic: the provider hosts are reached through a local forward proxy
 * that plays the provider's 401 (the github-org-access pattern), so no
 * request leaves the machine. Every id and name is made up.
 */

/** The provider's own refusal of a request that carried no credential. */
const UNAUTHORIZED = {
  status: 401,
  headers: { "content-type": "application/json" },
  body: '{"message":"missing API key"}',
} as const;

interface GuidanceBody {
  error: string;
  provider?: string;
  manage_url?: string;
  connect_url?: string;
  message?: string;
}

/** Seed `world`, then send one uncredentialed `url` through the gateway to a
 * provider that refuses it with 401. `authorization` is the header the
 * provider received, so a test can prove nothing was injected. */
const requestThroughProvider = async (
  cx: Cx,
  world: WorldSpec,
  url: string,
): Promise<{
  res: ProxyResponse;
  body: GuidanceBody;
  upstreamCalls: number;
  authorization: string | undefined;
}> => {
  await cx.seed(world);
  const proxy = await startForwardProxy({ respond: () => UNAUTHORIZED });
  try {
    const gw = await cx.startGateway({
      env: {
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        NO_PROXY: "127.0.0.1",
      },
    });
    const res = await throughProxy(gw.origin, {
      url,
      token: cx.ids.agentToken,
      timeoutMs: 30_000,
    });
    return {
      res,
      body: res.json() as GuidanceBody,
      upstreamCalls: proxy.requests().length,
      authorization: proxy.requests()[0]?.header("authorization"),
    };
  } finally {
    await proxy.close();
  }
};

describe("an app account that is off for the agent (wire-level)", () => {
  scenario(
    "an organization's account that is off for the agent is offered as a switch, connecting another as the alternative",
    async (cx) => {
      const { res, body, upstreamCalls, authorization } =
        await requestThroughProvider(
          cx,
          { appConnections: [{ provider: "resend", scope: "organization" }] },
          "http://api.resend.com/emails",
        );

      // The request really went out, and uncredentialed: this arm only
      // rewrites the provider's refusal, it never sends the off account's key.
      expect(upstreamCalls).toBe(1);
      expect(authorization).toBeUndefined();
      expect(res.status).toBe(401);
      expect(res.header("x-should-retry")).toBe("false");
      expect(body.error).toBe("access_restricted");
      expect(body.provider).toBe("resend");
      const workspace = `${GATEWAY_APP_URL}/w/${cx.ids.workspace}`;
      expect(body.manage_url).toBe(
        `${workspace}/agents/${cx.ids.agent}/connections?attach=resend`,
      );
      expect(body.connect_url).toMatch(
        new RegExp(
          `^${workspace}/connections\\?connect=resend&source=agent&agent_name=`,
        ),
      );
      expect(body.message).toContain(
        "Resend is already connected in OneCLI (shared by your organization), but it is turned off for this agent.",
      );
      // No account is ever named or identified to the agent.
      expect(JSON.stringify(body)).not.toContain(`${cx.ids.workspace}-conn-0`);
      expect(JSON.stringify(body)).not.toContain("resend-0");
    },
  );

  scenario(
    "an account waiting on a reconnect cannot be switched on, so the agent is told to connect",
    async (cx) => {
      const { body } = await requestThroughProvider(
        cx,
        { appConnections: [{ provider: "resend", reauthRequired: true }] },
        "http://api.resend.com/emails",
      );

      expect(body.error).toBe("app_not_connected");
      expect(body.manage_url).toBeUndefined();
      expect(body.connect_url).toMatch(/\/connections\?connect=resend/);
    },
  );

  scenario(
    "a Calendar account never answers for a Gmail request on the shared Google host",
    async (cx) => {
      // MUTATION-PROOF: match the inactive account by host instead of by
      // host AND path, and this reads as "switch Calendar on" for Gmail.
      const { body } = await requestThroughProvider(
        cx,
        { appConnections: [{ provider: "google-calendar" }] },
        "http://www.googleapis.com/gmail/v1/users/me/messages",
      );

      expect(body.error).toBe("app_not_connected");
      expect(body.connect_url).toMatch(/\/connections\?connect=gmail/);
    },
  );
});
