import { describe, expect } from "vitest";

import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * Salesforce accepts a create at `/sobjects/<Object>/` AND `/sobjects/<Object>`.
 * The catalog's create tool is written with a trailing slash (it pins depth,
 * so a create grant never reaches a record id), and the matcher used to take
 * that slash literally: every slashless create missed the tool and fell to
 * the grant's catch-all. Prod, 2026-09-29: an agent's `POST
 * /services/data/v59.0/sobjects/Contact` was refused 15 times in a row.
 *
 * Hermetic like `graphql-discrimination.test.ts`: every assertion is a refusal
 * whose rule NAME proves which rule decided, so nothing egresses. The create
 * tool is named in a BLOCK row ahead of a whole-app `fallthrough` block: a 403
 * naming the tool row means the tool claimed the path; one naming the
 * fallthrough means it missed (the pre-fix behavior for the slashless
 * spelling, and the required behavior for a record-id path).
 */
const WORLD = {
  rules: [
    {
      name: "create-tool",
      action: "block" as const,
      targets: [
        {
          kind: "app" as const,
          provider: "salesforce",
          tools: ["create_record"],
        },
      ],
    },
    {
      name: "salesforce-fallthrough",
      action: "block" as const,
      targets: [{ kind: "app" as const, provider: "salesforce" }],
    },
  ],
};

const ORG = "http://acme.my.salesforce.com";

const post = async (
  origin: string,
  token: string,
  path: string,
): Promise<unknown> => {
  const res = await throughProxy(origin, {
    method: "POST",
    url: `${ORG}${path}`,
    token,
    body: "{}",
  });
  expect(res.status, path).toBe(403);
  return res.json();
};

describe("salesforce create: both URL spellings reach the create tool (wire-level)", () => {
  scenario(
    "the slashed and slashless creates both hit the create tool",
    async (cx) => {
      await cx.seed(WORLD);
      const gw = await cx.startGateway();

      for (const path of [
        "/services/data/v59.0/sobjects/Contact/",
        // Before the fix this spelling missed the tool (salesforce-fallthrough).
        "/services/data/v59.0/sobjects/Contact",
      ]) {
        expect(
          await post(gw.origin, cx.ids.agentToken, path),
          path,
        ).toMatchObject({
          error: "blocked_by_policy",
          rule_name: "create-tool",
        });
      }
    },
  );

  scenario(
    "a record-id POST never reaches the create tool (depth stays pinned)",
    async (cx) => {
      await cx.seed(WORLD);
      const gw = await cx.startGateway();

      // POST to a record path is the `_HttpMethod` override shape: a create
      // grant must never cover it, with or without a trailing slash.
      for (const path of [
        "/services/data/v59.0/sobjects/Contact/003000000000001",
        "/services/data/v59.0/sobjects/Contact/003000000000001/",
        "/services/data/v59.0/sobjects",
      ]) {
        expect(
          await post(gw.origin, cx.ids.agentToken, path),
          path,
        ).toMatchObject({
          error: "blocked_by_policy",
          rule_name: "salesforce-fallthrough",
        });
      }
    },
  );
});
