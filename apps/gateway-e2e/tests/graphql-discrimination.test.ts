import { describe, expect } from "vitest";

import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * GraphQL operation discrimination, end to end through the real binary.
 *
 * GitHub's `graphql_query` and `graphql_mutation` catalog tools share ONE
 * endpoint (`POST api.github.com/graphql`); the gateway discriminates them by
 * classifying the request BODY fail-closed (policy-engine/src/graphql.rs). A
 * "Never" on mutations must therefore hold even when queries are allowed -
 * the exact Manage-permissions bypass this feature closes.
 *
 * The differential is hermetic: TWO block rules, first-match ordered. Which
 * rule a 403 names proves which side of the classifier the body landed on -
 * decided before any upstream socket is opened, so the real hostname never
 * egresses.
 *
 *   mutation-tagged rule matched  → the body classified as a mutation
 *   fallthrough (whole-app) rule  → the body classified as a pure query
 *
 * This also proves the body-buffer wiring through the shipped binary: without
 * `needs_body_buffer` arming for graphql-discriminated app targets, the
 * engine would see no body, EVERY request would fail closed to "mutation",
 * and the query arm below would name the wrong rule.
 */
const GRAPHQL_WORLD = {
  rules: [
    {
      name: "block-graphql-mutations",
      action: "block" as const,
      targets: [
        {
          kind: "app" as const,
          provider: "github",
          tools: ["graphql_mutation"],
        },
      ],
    },
    // The fallthrough: everything on the github app the first rule did NOT
    // match. A pure query must land here - proving it passed the mutation
    // gate - while staying blocked (hermetic, no egress).
    {
      name: "github-fallthrough",
      action: "block" as const,
      targets: [{ kind: "app" as const, provider: "github" }],
    },
  ],
};

const graphqlUrl = "http://api.github.com/graphql";

const envelope = (document: string): string =>
  JSON.stringify({ query: document });

describe("graphql operation discrimination (wire-level)", () => {
  scenario("a mutation dies on the mutation block", async (cx) => {
    await cx.seed(GRAPHQL_WORLD);
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      method: "POST",
      url: graphqlUrl,
      token: cx.ids.agentToken,
      headers: { "content-type": "application/json" },
      body: envelope(
        'mutation { createPullRequest(input: {baseRefName: "main"}) { pullRequest { number } } }',
      ),
    });

    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "block-graphql-mutations",
    });
  });

  scenario(
    "a pure query passes the mutation gate (lands on the fallthrough)",
    async (cx) => {
      await cx.seed(GRAPHQL_WORLD);
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        method: "POST",
        url: graphqlUrl,
        token: cx.ids.agentToken,
        headers: { "content-type": "application/json" },
        body: envelope(
          'query { repository(owner: "o", name: "r") { pullRequests(first: 5) { nodes { title } } } }',
        ),
      });

      // Naming the FALLTHROUGH rule is the proof: the query was classified as
      // a query (the mutation rule did not match), through the real buffered
      // body - while never leaving the gateway.
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "github-fallthrough",
      });
    },
  );

  scenario("a mixed query+mutation document fails closed", async (cx) => {
    await cx.seed(GRAPHQL_WORLD);
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      method: "POST",
      url: graphqlUrl,
      token: cx.ids.agentToken,
      headers: { "content-type": "application/json" },
      body: envelope(
        "query Q { viewer { login } } mutation M { createPullRequest(input: {}) { clientMutationId } }",
      ),
    });

    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "block-graphql-mutations",
    });
  });

  scenario("a bodyless POST /graphql fails closed", async (cx) => {
    await cx.seed(GRAPHQL_WORLD);
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      method: "POST",
      url: graphqlUrl,
      token: cx.ids.agentToken,
    });

    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "block-graphql-mutations",
    });
  });

  scenario("an unparsable body fails closed", async (cx) => {
    await cx.seed(GRAPHQL_WORLD);
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      method: "POST",
      url: graphqlUrl,
      token: cx.ids.agentToken,
      headers: { "content-type": "application/json" },
      body: '{"query": "query { viewer ', // truncated mid-document
    });

    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "block-graphql-mutations",
    });
  });

  scenario(
    "a non-graphql github endpoint is untouched by the discrimination",
    async (cx) => {
      await cx.seed(GRAPHQL_WORLD);
      const gw = await cx.startGateway();

      // A REST endpoint with a mutation-looking body: the graphql_mutation
      // tool's path (/graphql) does not cover it, so it lands on the
      // fallthrough regardless of body content.
      const res = await throughProxy(gw.origin, {
        method: "POST",
        url: "http://api.github.com/repos/o/r/issues",
        token: cx.ids.agentToken,
        headers: { "content-type": "application/json" },
        body: envelope("mutation { x }"),
      });

      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "github-fallthrough",
      });
    },
  );
});
