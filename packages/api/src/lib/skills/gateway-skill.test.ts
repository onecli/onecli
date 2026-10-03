import { describe, expect, it } from "vitest";
import { getGatewaySkill } from "./gateway-skill";

describe("gateway approval guidance", () => {
  it.each([undefined, "claude", "hermes"])(
    "scopes rejection without weakening policy blocks (%s)",
    (agent) => {
      const text = getGatewaySkill(agent).replace(/\s+/g, " ");
      expect(text.indexOf("`manual_approval_denied`")).toBeLessThan(
        text.indexOf("For other authentication"),
      );
      for (const guidance of [
        "reason=declined",
        "reason=expired",
        "may omit reason",
        "Do not automatically retry or bypass approval",
        "revise the draft without sending",
        "When the user explicitly asks to send or try again, submit a new request",
        "content is unchanged",
        "requires fresh approval",
        "exact method, URL, and body",
        "Never reuse a previous approval",
        "Do not tell the user to change policy or reconnect",
        "`blocked_by_policy` and `blocked_by_default_policy` are actual policy blocks",
        "Do not retry or circumvent it",
        "`connection_host_mismatch` (421)",
        "`connections[].host` is the real host",
        "Never invent or copy an example hostname",
        "`x-should-retry: false` disables automatic retries",
      ])
        expect(text).toContain(guidance);
      expect(text).not.toContain("policy error (403 with a JSON body)");
    },
  );

  it.each([undefined, "claude", "hermes"])(
    "teaches batch headers for many similar writes (%s)",
    (agent) => {
      const text = getGatewaySkill(agent).replace(/\s+/g, " ");
      for (const guidance of [
        "`X-OneCLI-Batch: <id>`",
        "`X-OneCLI-Batch-Label:",
        "`X-OneCLI-Batch-Total:",
        "at most 10 at a time",
        "don't fold them into one bulk call",
        "Never re-send a denied request unless the user asks",
        "`FirstPublishLocationId`",
        "one request, one approval",
      ]) {
        expect(text).toContain(guidance);
      }
    },
  );
});
