import { describe, expect, it } from "vitest";
import { getAppPermissionDefinitions } from ".";
import {
  toAppPermissionDefinitionSummary,
  wildcardCoversGroup,
  type AppTool,
} from "./types";

const methodsOf = (tool: AppTool): string[] =>
  tool.methods ?? (tool.method ? [tool.method] : []);

// Honesty invariant guarded by this file.
//
// A group's optional `wildcard` (e.g. a read group's "All read operations")
// is offered in the policy tools picker as a single compact selection that
// means "all of them". The client summary can't verify that — it carries no
// host/path — so the SERVER stamps each wildcard group with `wildcardComplete`,
// true only when the wildcard is a genuine superset of the group's tools. The
// picker offers the umbrella only when that flag is true.
//
// Unlike write wildcards (a security gate — every one MUST be complete, pinned
// by write-wildcard-coverage.test.ts), read wildcards are allowed to be
// incomplete; some genuinely are. This test pins which, so a catalog edit that
// silently changes a wildcard's coverage — making a "misleading all-reads"
// offerable, or dropping a now-complete one — turns the suite red.

// Every group across the catalog that ships a wildcard, paired with the
// server-computed summary flag for the same group.
const wildcardGroups = getAppPermissionDefinitions().flatMap((def) => {
  const summary = toAppPermissionDefinitionSummary(def);
  return def.groups.flatMap((group, index) =>
    group.wildcard
      ? [
          {
            provider: def.provider,
            category: group.category,
            wildcard: group.wildcard,
            tools: group.tools,
            summaryComplete: summary.groups[index]?.wildcardComplete,
          },
        ]
      : [],
  );
});

describe("wildcardComplete on the real catalog", () => {
  it("has at least one wildcard group to check", () => {
    expect(wildcardGroups.length).toBeGreaterThan(0);
  });

  it.each(wildcardGroups)(
    "$provider · $category wildcard is a prefix glob (path ends with /*)",
    ({ wildcard }) => {
      // `wildcardCoversGroup` strips the trailing "*" and compares the remaining
      // literal with `startsWith`. A "/*"-terminated pattern leaves a prefix
      // ending in "/", so a tool can only be "covered" at a segment boundary
      // (no "/api/v2foo" ⊇ "/api/v2" false positive). Guard the invariant the
      // coverage check relies on — matches write-wildcard-coverage.test.ts.
      expect(wildcard.pathPattern.endsWith("/*")).toBe(true);
    },
  );

  it.each(wildcardGroups)(
    "$provider · $category wildcard + every tool declares a method",
    ({ wildcard, tools }) => {
      // `wildcardCoversGroup`'s method check is `tool.methods.every(m ∈
      // wildcard.methods)`. A tool declaring NEITHER method nor methods yields
      // an empty list, which `.every` satisfies vacuously — silently marking it
      // "covered" regardless of the wildcard's methods (a method-less tool
      // matches every method at the gateway, so a GET-only umbrella would NOT
      // truly cover it). Pin that no wildcard-group tool omits its method, so
      // the coverage flag can't be fooled into offering a misleading umbrella.
      expect(methodsOf(wildcard).length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(methodsOf(tool).length).toBeGreaterThan(0);
      }
    },
  );

  it.each(wildcardGroups)(
    "$provider · $category summary flag equals the coverage function",
    ({ wildcard, tools, summaryComplete }) => {
      expect(summaryComplete).toBe(wildcardCoversGroup(wildcard, tools));
    },
  );

  it.each(wildcardGroups.filter((g) => g.category === "write"))(
    "$provider · write wildcard is complete (a gate must cover every write)",
    ({ summaryComplete }) => {
      // Mirrors the security guarantee in write-wildcard-coverage.test.ts: if a
      // write wildcard ever became incomplete, that test fails too — this one
      // ties the picker's offer to the same fact.
      expect(summaryComplete).toBe(true);
    },
  );
});

// Pin the specific known read-wildcard cases so the picker's behavior for them
// can't silently flip.
const readComplete = (provider: string): boolean | undefined => {
  const summary = toAppPermissionDefinitionSummary(
    getAppPermissionDefinitions().find((d) => d.provider === provider)!,
  );
  return summary.groups.find((g) => g.category === "read")?.wildcardComplete;
};

describe("known read-wildcard coverage", () => {
  it("gmail 'All read operations' is complete (/gmail/v1/* GET covers every read)", () => {
    expect(readComplete("gmail")).toBe(true);
  });

  it("jira 'All read operations' is INCOMPLETE (read_all is GET-only, JQL search is POST)", () => {
    expect(readComplete("jira")).toBe(false);
  });

  it("confluence 'All read operations' is INCOMPLETE (search lives on /wiki/rest/api, not the /wiki/api/v2/* umbrella)", () => {
    expect(readComplete("confluence")).toBe(false);
  });
});
