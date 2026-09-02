import { describe, expect } from "vitest";

import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * Stripe's governance surface, end to end through the real binary.
 *
 * Stripe is the first provider whose writes move real money, and its shape is
 * unusual in a way unit tests cannot fully settle: the gateway injects on TWO
 * hosts (`api.stripe.com` and the Files API's `files.stripe.com`) while every
 * catalog tool names only `api.stripe.com`. Matching on the upload host
 * therefore rides on the single-host-family mirror rule — and if that ever
 * stopped holding, a request there would carry the injected key while NO rule
 * matched it: credentialed but ungoverned, the exact class the host-decision
 * deferral exists to close.
 *
 * Hermetic despite naming real provider hosts: each request is blocked at the
 * policy engine, which decides before any credential is decrypted or any
 * socket to Stripe is opened. Nothing egresses.
 */
const STRIPE_API = "api.stripe.com";
const STRIPE_FILES = "files.stripe.com";

describe("stripe governance", () => {
  scenario("a whole-app rule governs the API host", async (cx) => {
    await cx.seed({
      grantAll: true,
      appConnections: [{ provider: "stripe" }],
      rules: [
        {
          name: "block-stripe",
          action: "block" as const,
          targets: [{ kind: "app" as const, provider: "stripe" }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: `http://${STRIPE_API}/v1/charges`,
      token: cx.ids.agentToken,
    });

    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "block-stripe",
    });
  });

  scenario(
    "a whole-app rule also governs the files upload host",
    async (cx) => {
      // The load-bearing one: `files.stripe.com` has no catalog tool of its
      // own, so this passes only while the app rule covers the provider's FULL
      // injection surface. A regression here is a silently ungoverned host.
      await cx.seed({
        grantAll: true,
        appConnections: [{ provider: "stripe" }],
        rules: [
          {
            name: "block-stripe",
            action: "block" as const,
            targets: [{ kind: "app" as const, provider: "stripe" }],
          },
        ],
      });
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        url: `http://${STRIPE_FILES}/v1/files`,
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "block-stripe",
      });
    },
  );

  scenario(
    "a stripe rule does not govern a browser-facing stripe host",
    async (cx) => {
      // The negative control. `dashboard.stripe.com` is outside the provider's
      // injection surface, so the Stripe rule must not match it. A second,
      // host-named block stands in the way so the request still dies here
      // rather than egressing: the SAME request that dies on `block-stripe` at
      // the API host must die on `backstop` here instead. Two different
      // rule_names is the proof the app rule's reach stops at the two API
      // hosts — asserted without leaving the machine.
      await cx.seed({
        grantAll: true,
        appConnections: [{ provider: "stripe" }],
        rules: [
          {
            name: "block-stripe",
            action: "block" as const,
            targets: [{ kind: "app" as const, provider: "stripe" }],
          },
          {
            name: "backstop",
            action: "block" as const,
            targets: [{ hostPattern: "dashboard.stripe.com" }],
          },
        ],
      });
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        url: "http://dashboard.stripe.com/v1/charges",
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(403);
      // The backstop decided, NOT the Stripe app rule.
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "backstop",
      });
    },
  );
});
