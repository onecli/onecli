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
        "`github_org_access_required` (403)",
        "never paste GitHub's own SSO or authorization links",
        "give them the `connect_url`",
        "`access_restricted` means OneCLI already has a credential",
        "do not ask the user to connect the service again",
        "Show the user the `manage_url`",
        "only for a user who wants a different account",
      ])
        expect(text).toContain(guidance);
      expect(text).not.toContain("policy error (403 with a JSON body)");
      // The skill is served to every surface (web chat, terminal, Slack):
      // it must not point at a button only the web chat renders.
      expect(text).not.toContain("Fix Access button");
    },
  );

  it.each([undefined, "claude", "hermes"])(
    "teaches doing what was asked or stopping to ask, for every app (%s)",
    (agent) => {
      const text = getGatewaySkill(agent).replace(/\s+/g, " ");
      for (const guidance of [
        "## Do What Was Asked, or Stop and Ask",
        "stop after the first failure",
        "offer what you could do instead, and wait for a yes",
        "Never swap in a different change on your own",
        "Before a write the user didn't spell out, say in one line what will change on which record",
        "Don't guess endpoints",
        "Never send a write to a URL you made up",
      ]) {
        expect(text).toContain(guidance);
      }
    },
  );

  it.each([undefined, "claude", "hermes"])(
    "teaches batch headers for many similar writes (%s)",
    (agent) => {
      const text = getGatewaySkill(agent).replace(/\s+/g, " ");
      for (const guidance of [
        "`X-OneCLI-Batch: <id>`",
        "`X-OneCLI-Batch-Label:",
        "`X-OneCLI-Batch-Total: <how many requests in this group>`",
        "split the list into groups of 25 and say how many cards to expect",
        "Each group of 25 is its own batch: a new id",
        "(2 of 5)",
        "the total counting only that group, never the whole list",
        "Wait until that group is decided before sending the next",
        "Updating a list of Salesforce records: send ONE bulk update** of up to 200 records",
        "PATCH /services/data/v62.0/composite/sobjects",
        "One record type per call. Each record sets only its own fields.",
        "so ONE approval for the whole list",
        "stop if they all failed",
        "the number started must equal the group's size",
        "loop over a file skips its last line",
        "read the records back and confirm each change landed",
        "with the same `X-OneCLI-Batch` headers as their group, so they join its card",
        "Never re-send a denied request unless the user asks",
        "`FirstPublishLocationId`",
        "one request, one approval",
      ]) {
        expect(text).toContain(guidance);
      }
      // The old cap split a 20-record task across two cards, and one batch
      // for a whole 105-record list left each card waiting for the rest.
      expect(text).not.toContain("at most 10 at a time");
      expect(text).not.toContain("up to 25 at once");
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
    "teaches naming fields by their screen label and people by name, never bare ids (%s)",
    (agent) => {
      // Mirrors the supervisor's connections fragment, which points at this
      // skill and must never diverge from it.
      const text = getGatewaySkill(agent).replace(/\s+/g, " ");
      for (const guidance of [
        "the way the user sees them in the app",
        "a field by the label on its screen",
        "taken from the app's own field metadata",
        "`GET /services/data/vXX.X/sobjects/<Object>/describe`",
        "never its API name",
        "or a guess",
        "a person or record by name",
        "tell them apart by something the user recognizes",
        "never by a bare id",
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
      // The exception names its path: the open proxy, which injects nothing,
      // so a browser task can never read as a way to pull a gateway credential.
      expect(text).toContain(
        "through the open proxy (the `OPEN_PROXY` variable",
      );
      expect(text).toContain("injects nothing");
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

describe("custom connection proposals", () => {
  it.each([undefined, "claude", "hermes"])(
    "teaches propose_custom_connection and never pasting keys in chat (%s)",
    (agent) => {
      const text = getGatewaySkill(agent).replace(/\s+/g, " ");
      for (const guidance of [
        "## Connecting a Service With No Built-in App",
        "`propose_custom_connection`",
        "Never guess them",
        "You never see the key",
        "**Never** ask them to paste a key into the chat",
        "one read-only GET",
        'version: "0.9.0"',
      ]) {
        expect(text).toContain(guidance);
      }
    },
  );
});
