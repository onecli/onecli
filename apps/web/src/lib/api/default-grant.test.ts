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
import { defaultGrantAccess } from "./default-grant";

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
