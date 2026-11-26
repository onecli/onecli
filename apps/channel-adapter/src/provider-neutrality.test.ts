import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANNEL_PROVIDER_IDS } from "@onecli/channels";
import {
  CHANNEL_ADAPTER_PROVIDERS,
  channelAdapterProviderFor,
} from "./providers";

/**
 * The adapter's module law: the orchestrator (adapter.ts, mirror.ts,
 * approvals.ts, targets.ts, providers.ts) is channel-neutral BY CONSTRUCTION
 * — every provider-specific fact (token shapes, event vocabularies, error
 * classes, block payloads, escaping) lives behind the `ChannelAdapterProvider`
 * contract in `src/<provider>/`. A Teams module is a directory plus one
 * registry line and inherits every orchestrator behavior, removal detection
 * included, with nothing to edit outside its own folder.
 *
 * This is the guard that keeps it true: it was written after a review found
 * the dead-credential relay reaching for Slack's error class and event shape
 * from the generic mirror and socket paths (2026-09-15) — the exact leak a
 * second provider would have silently missed.
 */
describe("the adapter orchestrator is channel-neutral", () => {
  const generic = [
    "adapter.ts",
    "mirror.ts",
    "approvals.ts",
    "targets.ts",
    "providers.ts",
    "control-plane.ts",
    "config.ts",
    "index.ts",
  ];

  it("no generic module imports a provider's own package or directory", () => {
    for (const file of generic) {
      const source = readFileSync(join(__dirname, file), "utf8");
      const imports = source
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line) || /from\s+"/.test(line));
      for (const id of CHANNEL_PROVIDER_IDS) {
        const offenders = imports.filter(
          (line) =>
            line.includes(`@onecli/channels/${id}`) ||
            line.includes(`./${id}/`) ||
            line.includes(`"./${id}"`),
        );
        // providers.ts is the ONE place a provider module is named: the
        // registry line that ships it.
        const allowed = file === "providers.ts" ? 1 : 0;
        expect(
          offenders.length,
          `${file} imports provider "${id}":\n${offenders.join("\n")}`,
        ).toBeLessThanOrEqual(allowed);
      }
    }
  });

  it("no generic module hard-codes a provider's event vocabulary or error class", () => {
    // The removal relay is the seam most likely to regress: the orchestrator
    // must relay whatever `removalEventFor` hands it, never build the event.
    for (const file of ["adapter.ts", "mirror.ts"]) {
      const source = readFileSync(join(__dirname, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(source, `${file} builds a provider event`).not.toMatch(
        /tokens_revoked|app_uninstalled|SlackApiError|isDeadCredentialError/,
      );
    }
  });

  it("every registered provider implements the full contract, removal detection included", () => {
    expect(Object.keys(CHANNEL_ADAPTER_PROVIDERS).sort()).toEqual(
      [...CHANNEL_PROVIDER_IDS].sort(),
    );
    for (const id of CHANNEL_PROVIDER_IDS) {
      const provider = channelAdapterProviderFor(id);
      expect(provider, `provider ${id}`).not.toBeNull();
      for (const member of [
        "credentialOf",
        "openTransport",
        "respondToOutcome",
        "decisionSettledText",
        "removalEventFor",
      ] as const) {
        expect(typeof provider![member], `${id}.${member}`).toBe("function");
      }
      // The contract's null arm: a failure the provider does not recognize
      // is never a removal.
      expect(provider!.removalEventFor(new Error("ECONNRESET"))).toBeNull();
      expect(provider!.removalEventFor("some_unknown_code")).toBeNull();
    }
  });
});
