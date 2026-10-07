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
        "`connection_needs_reconnect` (401)",
        "the request was NOT sent and no approval was requested",
        "Show the user the `connect_url`",
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

  it.each([undefined, "claude", "hermes"])(
    "teaches linking each changed record from a real link (%s)",
    (agent) => {
      const text = getGatewaySkill(agent).replace(/\s+/g, " ");
      for (const guidance of [
        "## Link What You Changed",
        "link each one in your reply",
        "from the API's own response (GitHub's `html_url`",
        "Salesforce returns no link, only the record id",
        "on the org host the gateway gave you for that connection",
        "Never guess a URL or copy an example hostname",
        "show the id instead",
      ]) {
        expect(text).toContain(guidance);
      }
    },
  );

  it.each([undefined, "claude", "hermes"])(
    "scopes the no-manual-auth rule to the gateway's services and carves out a user-provided website login (%s)",
    (agent) => {
      // Observed live: told "never use manual auth flows" and "you never
      // see credential values", an agent refused a website login the user
      // offered for a browser task. The rule stays for every service the
      // gateway connects; a login the user hands over is named as outside
      // it. API keys and tokens keep the dashboard path. MUTATION-PROOF:
      // restore the unscoped wording or drop the carve-out and this fails.
      const text = getGatewaySkill(agent).replace(/\s+/g, " ");
      expect(text).toContain(
        "You never see or handle the gateway's credential values directly",
      );
      expect(text).toContain(
        "**Never** use browser extensions, gcloud, or manual auth flows for a service the gateway connects",
      );
      expect(text).toContain(
        "A website login the user hands you for a browser task is not a gateway auth flow",
      );
      expect(text).toContain("keep it out of your replies and memory");
      expect(text).toContain(
        "prefer a connection when one exists for that service",
      );
      expect(text).toContain(
        "**Never** ask the user for API keys or tokens directly",
      );
    },
  );
});
