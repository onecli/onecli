import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANNEL_PROVIDER_UIS } from "./channel-providers/registry";

/**
 * The dashboard's channel module law, the twin of the api's and the
 * adapter's `provider-neutrality.test.ts`: the GENERIC channel surfaces —
 * the agent's Channels section, the agent rail's connected mark, the
 * sidebar's agent rows, and the provider-label/icon helpers — never name a
 * provider. They iterate presences and look the provider up in
 * `channel-providers/registry.ts`; the provider's cards, name and mark live
 * in `channel-providers/<id>.tsx` and the `<id>-*` components it names. A
 * Teams module is a component directory plus one registry line and gets the
 * section, the marks and the connect round-trip with nothing else to edit.
 *
 * Written 2026-09-15 after a whole-PR neutrality audit found the section
 * mounting the Slack cards directly and both marks calling a Slack-only
 * predicate.
 */
describe("the generic channel surfaces are provider-neutral", () => {
  const root = join(__dirname, "..", "..");
  const generic = [
    "app/(dashboard)/w/[workspaceId]/agents/[agentId]/channels/_components/channels-section.tsx",
    "app/(dashboard)/w/[workspaceId]/agents/[agentId]/_components/agent-section-rail.tsx",
    "lib/dashboard/agents-group.tsx",
    "lib/agents/channel-provider-ui.ts",
    "lib/agents/channel-providers.ts",
  ];
  const ids = CHANNEL_PROVIDER_UIS.map((ui) => ui.id);

  it("no generic surface imports a provider's UI module or components", () => {
    for (const file of generic) {
      const source = readFileSync(join(root, file), "utf8");
      const importLines = source
        .split("\n")
        .filter((line) => /from\s+"/.test(line));
      for (const id of ids) {
        const offenders = importLines.filter(
          (line) =>
            line.includes(`/${id}-`) ||
            line.includes(`channel-providers/${id}"`) ||
            line.includes(`${id}-presence"`),
        );
        expect(
          offenders.length,
          `${file} imports provider "${id}" directly:\n${offenders.join("\n")}`,
        ).toBe(0);
      }
    }
  });

  it("no generic surface branches on a provider id", () => {
    for (const file of generic) {
      const code = readFileSync(join(root, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
        .join("\n");
      for (const id of ids) {
        const literal = new RegExp(`(["'\`])${id}\\1`);
        const hits = code
          .split("\n")
          .filter((line) => literal.test(line))
          .filter((line) => /===?|!==?|provider\s*[:=]/.test(line));
        expect(
          hits,
          `${file} keys on provider "${id}":\n${hits.join("\n")}`,
        ).toEqual([]);
      }
    }
  });
});
