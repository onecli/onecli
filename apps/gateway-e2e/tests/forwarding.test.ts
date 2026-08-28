import { describe, expect } from "vitest";

import { GATEWAY_APP_URL } from "../src/gateway.js";
import { streamThroughProxy, throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * What the gateway does with a response it is merely passing through.
 *
 * These are the behaviors a restructure is most likely to break silently: they
 * are not policy decisions with loud failure modes, they are the quiet
 * obligations of being a proxy, and every one of them is invisible to a test
 * that only checks a status code.
 */
describe("response passthrough", () => {
  scenario("does not follow redirects", async (cx) => {
    const upstream = await cx.upstream();
    upstream.respond({
      status: 302,
      headers: {
        location: "https://example.invalid/elsewhere",
        "x-marker": "kept",
      },
      body: "",
    });
    await cx.seed();
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/start"),
      token: cx.ids.agentToken,
    });

    // The agent decides whether to follow. A gateway that followed would strip
    // the agent's ability to see the hop at all — and would re-inject the
    // credential at a destination policy never evaluated.
    expect(res.status).toBe(302);
    expect(res.header("location")).toBe("https://example.invalid/elsewhere");
    expect(res.header("x-marker")).toBe("kept");
    expect(upstream.requests()).toHaveLength(1);
  });

  scenario("strips hop-by-hop headers from the response", async (cx) => {
    const upstream = await cx.upstream();
    upstream.respond({
      status: 200,
      headers: {
        connection: "close",
        "keep-alive": "timeout=5",
        "x-passthrough": "kept",
      },
      body: "{}",
    });
    await cx.seed();
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });

    // Hop-by-hop headers describe the upstream connection, not this one.
    // Forwarding them corrupts the client's view of its own socket.
    expect(res.header("keep-alive")).toBeUndefined();
    expect(res.header("x-passthrough")).toBe("kept");
  });

  scenario("streams a chunked response without buffering it", async (cx) => {
    const upstream = await cx.upstream();
    upstream.respondStream({
      status: 200,
      chunks: ["data: one\n\n", "data: two\n\n", "data: three\n\n"],
      gapMs: 150,
    });
    await cx.seed();
    const gw = await cx.startGateway();

    const res = await streamThroughProxy(gw.origin, {
      url: upstream.url("/v1/messages"),
      token: cx.ids.agentToken,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toBe("data: one\n\ndata: two\n\ndata: three\n\n");
    // A gateway that collected the whole body before replying would deliver
    // identical bytes and pass every check above, so the streaming itself has
    // to be observed directly.
    expect(res.chunks.length).toBeGreaterThan(1);
    // This is the load-bearing assertion, not the chunk count: with the stub's
    // gap set to 0 the count still exceeds 1 (TCP segments the write anyway),
    // but the elapsed time collapses from ~300ms to ~2ms. Only the clock can
    // tell "forwarded as it arrived" from "buffered and then written".
    const last = res.chunks.at(-1);
    expect(last?.atMs).toBeGreaterThan(100);
  });
});

/**
 * When an upstream rejects a request the gateway did NOT credential, it
 * replaces the bare 401/403 with guidance the agent can act on
 * (`forward.rs:683-790`). Nothing else in the suite covers this surface, and it
 * is the gateway's most agent-visible behavior after policy.
 */
describe("credential guidance", () => {
  scenario("rewrites an uncredentialed 401 into guidance", async (cx) => {
    const upstream = await cx.upstream();
    upstream.respond({ status: 401, body: '{"error":"missing api key"}' });
    // No secret for this host, so nothing is injected and the gateway knows the
    // rejection is about a credential it could have supplied.
    await cx.seed();
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/v1/models?limit=5"),
      token: cx.ids.agentToken,
    });

    expect(res.status).toBe(401);
    expect(res.header("x-should-retry")).toBe("false");
    const body = res.json() as { error: string; secret_url: string };
    expect(body.error).toBe("credential_not_found");
    // The link is the whole point of the response, and it is assembled from
    // APP_URL plus the workspace id — both of which a restructure can drop.
    expect(body.secret_url).toContain(GATEWAY_APP_URL);
  });

  scenario("passes a credentialed 401 through untouched", async (cx) => {
    const upstream = await cx.upstream();
    upstream.respond({ status: 401, body: '{"error":"upstream says no"}' });
    await cx.seed({
      grantAll: true,
      secrets: [
        {
          hostPattern: "127.0.0.1",
          headerName: "x-test-key",
          value: "sk-e2e-guidance",
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });

    // The negative control. A credential WAS injected, so the 401 is the
    // upstream's real verdict and the gateway must not editorialise it.
    expect(res.status).toBe(401);
    expect(res.body).toContain("upstream says no");
    expect(res.header("x-should-retry")).toBeUndefined();
  });

  scenario("forwards a 400 that is not about credentials", async (cx) => {
    const upstream = await cx.upstream();
    const body = '{"error":"invalid_argument","message":"field required"}';
    upstream.respond({ status: 400, body });
    await cx.seed();
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });

    // A 400 is sniffed for auth wording before being rewritten. This one has
    // none, so it must arrive byte-identical — the sniff must not swallow
    // ordinary validation errors.
    expect(res.status).toBe(400);
    expect(res.body).toBe(body);
    expect(res.header("x-should-retry")).toBeUndefined();
  });

  scenario("rewrites a 400 that reads as an auth failure", async (cx) => {
    const upstream = await cx.upstream();
    upstream.respond({ status: 400, body: '{"error":"invalid API key"}' });
    await cx.seed();
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: upstream.url("/v1/models"),
      token: cx.ids.agentToken,
    });

    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: "credential_not_found" });
    expect(res.header("x-should-retry")).toBe("false");
  });
});
