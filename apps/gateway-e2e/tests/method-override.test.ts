import { describe, expect } from "vitest";

import { compiledGrantStack } from "../src/fixtures.js";
import { startForwardProxy } from "../src/forward-proxy.js";
import { throughProxy } from "../src/proxy.js";
import { scenario, type Cx } from "../src/scenario.js";

/**
 * A request asking the upstream to run another method is refused.
 *
 * Services disagree on method overrides: Salesforce runs
 * `POST …?_HttpMethod=DELETE` as a delete, Google runs a POST carrying
 * `X-HTTP-Method-Override` as the named method, and GitHub ignores the header
 * and runs the POST. Judging by either method is wrong for some service, so
 * the gateway judges the request line and refuses any override naming a
 * different method, before a rule is consulted or a credential minted.
 *
 * Hermetic: refusals never egress; the one forwarded request (the control)
 * goes to a local forward proxy that records it.
 */
const GH = "http://api.github.com";
const ISSUES = `${GH}/repos/acme/web/issues`;
const RECORD =
  "http://acme.my.salesforce.com/services/data/v62.0/sobjects/Contact/003AA00000AbCdEFGH";

/** A customized GitHub grant: listing issues allowed, creating them Never. */
const listIssuesOnly = {
  appConnections: [{ provider: "github-app", label: "acme" }],
  rules: compiledGrantStack("github-app", ["list_issues"], {
    otherReads: "allow",
  }),
};

const proxied = async (
  cx: Cx,
  send: (origin: string) => ReturnType<typeof throughProxy>,
) => {
  const proxy = await startForwardProxy();
  try {
    const gw = await cx.startGateway({
      env: {
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        NO_PROXY: "127.0.0.1",
      },
    });
    const res = await send(gw.origin);
    return { res, forwarded: proxy.requests().map((r) => r.url) };
  } finally {
    await proxy.close();
  }
};

describe("method overrides", () => {
  scenario(
    "a POST dressed as a GET can't create an issue through a read grant",
    async (cx) => {
      await cx.seed(listIssuesOnly);
      const { res, forwarded } = await proxied(cx, (origin) =>
        throughProxy(origin, {
          method: "POST",
          url: ISSUES,
          token: cx.ids.agentToken,
          headers: {
            "content-type": "application/json",
            "x-http-method-override": "GET",
          },
          body: JSON.stringify({ title: "e2e" }),
        }),
      );
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "method_override_refused",
        method: "POST",
        override: "GET",
      });
      // The agent is told what to do instead.
      expect((res.json() as { message: string }).message).toMatch(
        /using the method you mean as the HTTP method itself/,
      );
      expect(forwarded).toEqual([]);
    },
  );

  scenario(
    "the same create without the override is judged and blocked as a POST",
    async (cx) => {
      await cx.seed(listIssuesOnly);
      const res = await throughProxy((await cx.startGateway()).origin, {
        method: "POST",
        url: ISSUES,
        token: cx.ids.agentToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "e2e" }),
      });
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({ error: "blocked_by_policy" });
    },
  );

  scenario(
    "an override repeating the request line's own method passes",
    async (cx) => {
      await cx.seed(listIssuesOnly);
      const { res, forwarded } = await proxied(cx, (origin) =>
        throughProxy(origin, {
          url: ISSUES,
          token: cx.ids.agentToken,
          headers: { "x-http-method-override": "get" },
          timeoutMs: 30_000,
        }),
      );
      expect(res.status).toBe(200);
      expect(forwarded).toEqual([ISSUES]);
    },
  );

  scenario(
    "a Salesforce POST ?_HttpMethod=DELETE is refused before any rule",
    async (cx) => {
      // No rules: a 403 here can only be the override refusal.
      await cx.seed({});
      const gw = await cx.startGateway();
      const res = await throughProxy(gw.origin, {
        method: "POST",
        url: `${RECORD}?_HttpMethod=DELETE`,
        token: cx.ids.agentToken,
      });
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "method_override_refused",
        override: "DELETE",
      });
    },
  );
});
