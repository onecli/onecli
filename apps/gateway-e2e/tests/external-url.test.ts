import { describe, expect } from "vitest";

import { GATEWAY_APP_URL } from "../src/gateway.js";
import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * The canonical-vs-alias contract in the real binary.
 *
 * The harness spawns every gateway with the legacy `APP_URL` (gateway.ts:245),
 * so the whole rest of the suite doubles as the permanent-alias regression.
 * This file pins the other half: `ONECLI_EXTERNAL_URL` wins over the alias in
 * the links the gateway hands agents — the exact chain-head order the Node
 * resolver uses, mirrored in `response.rs`.
 */
describe("ONECLI_EXTERNAL_URL in agent-facing links", () => {
  scenario(
    "canonical beats the APP_URL alias in credential guidance",
    async (cx) => {
      const upstream = await cx.upstream();
      upstream.respond({ status: 401, body: '{"error":"missing api key"}' });
      await cx.seed();
      const gw = await cx.startGateway({
        env: { ONECLI_EXTERNAL_URL: "http://canonical.e2e.test:10254" },
      });

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/v1/models"),
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(401);
      const body = res.json() as { secret_url: string };
      expect(body.secret_url).toContain("http://canonical.e2e.test:10254");
      expect(body.secret_url).not.toContain(GATEWAY_APP_URL);
    },
  );
});
