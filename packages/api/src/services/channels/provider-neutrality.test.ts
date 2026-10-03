import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANNEL_PROVIDER_IDS } from "@onecli/channels";
import { CHANNEL_PROVIDERS, channelProvider } from "./registry";

/**
 * The control plane's channel module law, the twin of the adapter's
 * `provider-neutrality.test.ts`: everything in `services/channels/*.ts`
 * (the generic layer — presences, ingestion, approvals, reach, sending,
 * recipient search, removal detection) is channel-neutral BY CONSTRUCTION.
 * Provider facts — API clients, token shapes, event vocabularies, mention
 * grammar, error codes, tenant fences — live in `providers/<id>/` behind the
 * `ChannelProvider` contract, and the registry is the ONE place a provider
 * module is named. A Teams module is a directory plus a registry line and
 * inherits send_message, find_recipient, inbound decoding, receipts, the
 * removal doors and the agent-facing "Where you talk" section, with nothing
 * to edit in this layer.
 *
 * Written 2026-09-15 after a whole-PR audit found the generic sending and
 * search services importing the Slack client directly and querying
 * `provider: "slack"`, and ingestion gating its decode on the Slack id —
 * the exact leaks a second provider would have silently missed.
 */
describe("the channels service layer is provider-neutral", () => {
  const dir = __dirname;
  const generic = readdirSync(dir).filter(
    (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts"),
  );

  it("no generic module imports a provider's client package or directory (the registry names each once)", () => {
    for (const file of generic) {
      const source = readFileSync(join(dir, file), "utf8");
      const importLines = source
        .split("\n")
        .filter(
          (line) =>
            /^\s*(import|export)\b.*from\s+"/.test(line) ||
            /^\s*\} from\s+"/.test(line),
        );
      for (const id of CHANNEL_PROVIDER_IDS) {
        const offenders = importLines.filter(
          (line) =>
            line.includes(`@onecli/channels/${id}`) ||
            line.includes(`./providers/${id}/`) ||
            line.includes(`./providers/${id}"`),
        );
        const allowed = file === "registry.ts" ? 1 : 0;
        expect(
          offenders.length,
          `${file} imports provider "${id}":\n${offenders.join("\n")}`,
        ).toBeLessThanOrEqual(allowed);
      }
    }
  });

  it("no generic module branches on a provider id or queries by it", () => {
    for (const file of generic) {
      if (file === "registry.ts") continue;
      const code = readFileSync(join(dir, file), "utf8")
        .split("\n")
        // Comments may name providers as examples; code may not.
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      for (const id of CHANNEL_PROVIDER_IDS) {
        const literal = new RegExp(`(["'])${id}\\1`);
        const hits = code
          .split("\n")
          .filter((line) => literal.test(line))
          // A `provider: "slack"` query or `=== "slack"` branch is the leak;
          // a string that merely CONTAINS the word (a URL, a label) is not.
          .filter((line) =>
            /provider\s*[:=!]|===?\s*["']|!==?\s*["']/.test(line),
          );
        expect(
          hits,
          `${file} keys on provider "${id}":\n${hits.join("\n")}`,
        ).toEqual([]);
      }
    }
  });

  it("every declared provider id has a registry entry implementing the outbound contract", () => {
    expect(Object.keys(CHANNEL_PROVIDERS).sort()).toEqual(
      [...CHANNEL_PROVIDER_IDS].sort(),
    );
    for (const id of CHANNEL_PROVIDER_IDS) {
      const provider = channelProvider(id);
      expect(provider.id).toBe(id);
      expect(provider.displayName.length).toBeGreaterThan(0);
      for (const member of [
        "sendMessage",
        "listMembers",
        "listChannels",
        "addReceiptReaction",
        "removeReceiptReaction",
        "dispatchInbound",
      ] as const) {
        expect(typeof provider[member], `${id}.${member}`).toBe("function");
      }
    }
  });
});
