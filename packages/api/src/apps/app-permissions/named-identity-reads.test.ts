import { describe, expect, it } from "vitest";
import {
  compileConnectionStack,
  defaultConnectionGrant,
} from "../../services/grants-compile";
import { evaluateNew } from "../../services/policy-translation/evaluator";
import type {
  NewRule,
  PolicyRequest,
} from "../../services/policy-translation/types";
import type { ConnectionGrantInput } from "../../validations/grants";

const cases = [
  { provider: "notion", tool: "get_user", path: "/v1/users/me" },
  { provider: "notion", tool: "get_user", path: "/v1/users/user-id" },
];
const host = "api.notion.com";
const decide = (
  provider: string,
  grant: ConnectionGrantInput,
  request: Partial<PolicyRequest>,
) => {
  const rules: NewRule[] = compileConnectionStack(
    "Identity read",
    provider,
    grant,
  ).map((row, priority) => ({
    ...row,
    scope: "workspace",
    priority,
    isDefault: false,
    source: "grant",
    identities: [],
    targets: [
      {
        kind: "connection",
        connectionId: "selected",
        provider,
        tools: row.tools,
        method: row.method,
      },
    ],
    rateLimit: null,
    rateLimitWindow: null,
    conditions: null,
  }));
  rules.push({
    scope: "workspace",
    priority: 999,
    isDefault: true,
    source: "default",
    name: "Default deny",
    identities: [],
    targets: [],
    action: "block",
    requireApproval: false,
    rateLimit: null,
    rateLimitWindow: null,
    conditions: null,
  });
  return evaluateNew(rules, {
    host,
    path: "/",
    method: "GET",
    agentId: "agent",
    hasInjections: true,
    isLlmHost: false,
    winningConnectionId: "selected",
    ...request,
  });
};
const custom = (
  tool: string,
  choice: "allow" | "ask" | "never",
): ConnectionGrantInput => ({
  access: "custom",
  allow: choice === "allow" ? [tool] : [],
  ask: choice === "ask" ? [tool] : [],
  otherReads: "never",
  otherWrites: "never",
});

describe("Named identity reads in connection grants", () => {
  it.each(cases)(
    "$provider/$tool is a named default read and retains current catch-alls",
    ({ provider, tool, path }) => {
      const grant = defaultConnectionGrant(provider);
      expect(grant).toMatchObject({
        access: "custom",
        otherReads: "allow",
        otherWrites: "ask",
      });
      if (grant.access !== "custom")
        throw new Error("Expected catalog default grant");
      expect(grant.allow).toContain(tool);
      expect(grant.ask).not.toContain(tool);
      expect(decide(provider, grant, { path })).toEqual({ action: "allow" });
      expect(decide(provider, grant, { path: "/unlisted-proof" })).toEqual({
        action: "allow",
      });
      expect(
        decide(provider, grant, { path: "/unlisted-proof", method: "POST" }),
      ).toEqual({ action: "allow", requireApproval: true });
    },
  );

  it.each(cases)(
    "$provider/$tool honors explicit allow, approval and never with closed catch-alls",
    ({ provider, tool, path }) => {
      expect(decide(provider, custom(tool, "allow"), { path })).toEqual({
        action: "allow",
      });
      expect(decide(provider, custom(tool, "ask"), { path })).toEqual({
        action: "allow",
        requireApproval: true,
      });
      expect(decide(provider, custom(tool, "never"), { path })).toEqual({
        action: "block",
      });
      expect(
        decide(provider, custom(tool, "allow"), { path: `${path}?page=1` }),
      ).toEqual({ action: "allow" });
    },
  );

  it.each(cases)(
    "$provider/$tool fences other methods, hosts, paths and accounts",
    ({ provider, tool, path }) => {
      for (const request of [
        { path, method: "POST" },
        { path, method: "DELETE" },
        { path, host: `${host}.evil.test` },
        { path: "/unlisted-proof" },
        { path, winningConnectionId: "other" },
      ])
        expect(decide(provider, custom(tool, "allow"), request).action).toBe(
          "block",
        );
    },
  );
});
