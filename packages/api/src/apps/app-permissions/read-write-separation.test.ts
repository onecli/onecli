import { describe, expect, it } from "vitest";
import { getAppPermissionDefinitions } from ".";
import type { AppPermissionDefinition } from "./types";
import { allRuleVariants } from "../../services/policy-translation/translate/app-catalog";
import {
  synthesizeBody,
  synthesizeHost,
  synthesizePath,
} from "../../services/policy-reflect/effective-tools";
import { evaluatePolicyOutcome } from "../../services/policy-translation/evaluator";
import type { NewRule } from "../../services/policy-translation/types";

// Read/write separation law, guarded by this file.
//
// The most common guardrail is "writes need approval" (or "block writes"):
// one rule naming exactly an app's write tools. For that to mean what it
// says, no read tool's request may be matched by a rule naming only write
// tools, and vice versa. When a read and a write tool resolve to the same
// request (one GraphQL endpoint, or a path wildcard broad enough to swallow
// a sibling write endpoint), the engine cannot tell them apart: the rule
// silently governs the other category too, at the gateway AND in Manage
// permissions ("Org minimum: needs approval" on every read row).
//
// The check runs each tool's representative request (the same synthesis the
// reflection uses) through the real evaluator against a rule naming the
// OTHER category's tools. Fix a failure by giving the tools distinguishable
// requests: `graphqlOps` for a shared GraphQL endpoint (see linear.ts,
// monday.ts), or a narrower path pattern.
//
// Only a group's explicit `tools` take part, never its `wildcard`. The
// umbrellas are prefix globs over a whole API, and some deliberately reach
// across categories (Jira's `write_all` covers POST /search/jql, which is the
// read tool `search_issues`); that incompleteness is already surfaced to the
// picker by `wildcardCoversGroup`, and is not what this law is about.

type Category = "read" | "write";

/** An org "needs approval" rule naming exactly one category's tools, or null
 * when the app has no tools of that category. */
const ruleNaming = (
  def: AppPermissionDefinition,
  category: Category,
): NewRule | null => {
  const tools = def.groups
    .filter((g) => g.category === category)
    .flatMap((g) => g.tools.map((t) => t.id));
  if (tools.length === 0) return null;
  return {
    scope: "organization",
    priority: 1,
    isDefault: false,
    source: "custom",
    name: `${category} guardrail`,
    identities: [],
    targets: [
      { kind: "app", provider: def.provider, tools, connectionScope: null },
    ],
    action: "allow",
    requireApproval: true,
    rateLimit: null,
    rateLimitWindow: null,
    conditions: null,
  };
};

/** Tools of `probe` category whose request a rule naming `ruled` matches. */
const crossMatches = (
  def: AppPermissionDefinition,
  ruled: Category,
  probe: Category,
): string[] => {
  const rule = ruleNaming(def, ruled);
  if (!rule) return [];
  return def.groups
    .filter((g) => g.category === probe)
    .flatMap((g) => g.tools)
    .filter((tool) => {
      const host = synthesizeHost(tool.hostPattern);
      return allRuleVariants(tool).some(
        (v) =>
          evaluatePolicyOutcome([rule], {
            host,
            path: synthesizePath(v.pathPattern),
            method: v.method ?? "GET",
            body: synthesizeBody(tool),
            agentId: "a",
            hasInjections: true,
            isLlmHost: false,
          }).kind === "rule",
      );
    })
    .map((t) => t.id);
};

describe("read/write separation (a rule on one category never decides the other)", () => {
  for (const def of getAppPermissionDefinitions()) {
    it(`${def.provider}: a write-only rule matches no read request`, () => {
      expect(crossMatches(def, "write", "read")).toEqual([]);
    });
    it(`${def.provider}: a read-only rule matches no write request`, () => {
      expect(crossMatches(def, "read", "write")).toEqual([]);
    });
  }
});
