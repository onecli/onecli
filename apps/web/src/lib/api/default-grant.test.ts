import type { Prisma } from "@onecli/db";
import {
  getAppPermissionDefinitions,
  toAppPermissionDefinitionSummary,
} from "@onecli/api/apps/app-permissions";
import {
  compileConnectionStack,
  defaultConnectionGrant,
  stackToGrant,
} from "@onecli/api/services/grants-compile";
import { describe, expect, it } from "vitest";
import { defaultGrantAccess, defaultGrantConsent } from "./default-grant";

/**
 * The switch-on placeholder must be exactly what the agent page reads back
 * once the server's default grant is stored, for EVERY catalog: a mismatch
 * would show one access summary for a beat and then flip to another. So the
 * reference is the server's full round trip (default → compiled stack →
 * read back), not just its input.
 */

type Row = Parameters<typeof stackToGrant>[0][number];

/** The row shape `stackToGrant` reads, as the grants service stores it. */
const asRows = (stack: ReturnType<typeof compileConnectionStack>): Row[] =>
  stack.map(
    (rule) =>
      ({
        action: rule.action,
        requireApproval: rule.requireApproval,
        targets: [
          {
            appTools: rule.tools,
            method: rule.method ?? null,
          },
        ],
        conditions: null satisfies Prisma.JsonValue,
      }) as unknown as Row,
  );

const readBack = (provider: string) =>
  stackToGrant(
    asRows(
      compileConnectionStack(
        "Grant: a · c",
        provider,
        defaultConnectionGrant(provider),
      ),
    ),
    provider,
  );

describe("defaultGrantAccess", () => {
  const definitions = getAppPermissionDefinitions();

  it("covers a real set of catalogs", () => {
    expect(definitions.length).toBeGreaterThan(10);
  });

  it.each(definitions.map((def) => [def.provider, def] as const))(
    "%s: matches what the server stores and reads back",
    (provider, def) => {
      expect(defaultGrantAccess(toAppPermissionDefinitionSummary(def))).toEqual(
        readBack(provider),
      );
    },
  );

  it("an app with no catalog gets full access, like the server", () => {
    expect(defaultGrantAccess(undefined)).toEqual(readBack("no-such-provider"));
  });
});

/** What the consent line must say for a grant the server actually stores. */
const expectedConsent = (
  grant: ReturnType<typeof readBack>,
  exhaustive = false,
): string =>
  grant.access === "full"
    ? "It gets full access."
    : grant.otherReads === "allow" || exhaustive
      ? "Writes need your approval."
      : "Writes, and reads that could expose secrets, need your approval.";

describe("defaultGrantConsent", () => {
  const definitions = getAppPermissionDefinitions();

  it.each(definitions.map((def) => [def.provider, def] as const))(
    "%s: states what the server stores, never less approval",
    (provider, def) => {
      expect(defaultGrantConsent(toAppPermissionDefinitionSummary(def))).toBe(
        // An exhaustive catalog has no reads outside its tools: its stored
        // catch-all can match nothing, so it is no approval to promise.
        expectedConsent(readBack(provider), def.exhaustive === true),
      );
    },
  );

  it("says full access for an app with no catalog", () => {
    expect(defaultGrantConsent(undefined)).toBe("It gets full access.");
  });
});
