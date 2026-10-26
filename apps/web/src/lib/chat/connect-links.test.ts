import { describe, expect, it } from "vitest";
import {
  extractConnectSuggestions,
  isCardConnectLink,
  parseConnectLink,
} from "./connect-links";

const GMAIL_CONNECT_URL =
  "https://app.onecli.sh/w/a/connections?connect=gmail&source=agent&agent_name=Arik";

describe("parseConnectLink", () => {
  it("parses the gateway's connect URL shape", () => {
    expect(parseConnectLink(GMAIL_CONNECT_URL)).toEqual({
      provider: "gmail",
      agentName: "Arik",
      kind: "connect",
    });
  });

  it("parses without the agent context", () => {
    expect(
      parseConnectLink("https://app.onecli.sh/connections?connect=github"),
    ).toEqual({ provider: "github", agentName: undefined, kind: "connect" });
  });

  it("ignores ordinary links and non-connect connections URLs", () => {
    expect(parseConnectLink("https://example.com/page")).toBeNull();
    expect(
      parseConnectLink("https://app.onecli.sh/w/abc/connections"),
    ).toBeNull();
    expect(parseConnectLink("not a url")).toBeNull();
  });

  it("refuses a provider id outside the id alphabet — no HTML or path tricks", () => {
    expect(
      parseConnectLink(
        "https://app.onecli.sh/connections?connect=%3Cscript%3E",
      ),
    ).toBeNull();
    expect(
      parseConnectLink("https://app.onecli.sh/connections?connect=../../x"),
    ).toBeNull();
  });
});

describe("parseConnectLink: the connection_needs_reconnect shape", () => {
  it("names the dead account the gateway's reconnect link points at", () => {
    expect(
      parseConnectLink(
        "https://app.onecli.sh/w/abc/connections/apps/salesforce?reconnect=f163a8ae%2D7ee3%2D4599",
      ),
    ).toEqual({
      provider: "salesforce",
      kind: "reconnect",
      connectionId: "f163a8ae-7ee3-4599",
    });
  });

  it("parses a hyphenated provider exactly as the gateway writes it", () => {
    expect(
      parseConnectLink(
        "https://app.onecli.sh/w/abc/connections/apps/google-calendar?reconnect=c1",
      ),
    ).toEqual({
      provider: "google-calendar",
      kind: "reconnect",
      connectionId: "c1",
    });
  });

  it("falls back to attach when the id is not a plain id", () => {
    expect(
      parseConnectLink(
        "https://app.onecli.sh/connections/apps/salesforce?reconnect=a%20b",
      ),
    ).toEqual({ provider: "salesforce", kind: "attach" });
  });
});

describe("parseConnectLink: the github_org_access_required shape", () => {
  it("names the GitHub organization that refused the account", () => {
    expect(
      parseConnectLink(
        "https://app.onecli.sh/w/abc/connections/apps/github?org_access=Acme-Labs",
      ),
    ).toEqual({ provider: "github", kind: "org_access", org: "Acme-Labs" });
  });

  it("falls back to attach for anything that is not an org login", () => {
    expect(
      parseConnectLink(
        "https://app.onecli.sh/connections/apps/github?org_access=a%2Fb",
      ),
    ).toEqual({ provider: "github", kind: "attach" });
  });

  it("is GitHub's alone: another app's page ignores the parameter", () => {
    expect(
      parseConnectLink(
        "https://app.onecli.sh/w/abc/connections/apps/gitlab?org_access=acme",
      ),
    ).toEqual({ provider: "gitlab", kind: "attach" });
  });

  it("renders as a card row with the org", () => {
    const text =
      "Ask the user to open https://app.onecli.sh/w/a/connections/apps/github?org_access=acme. Then retry.";
    const [row] = extractConnectSuggestions(text);
    expect(row?.app.id).toBe("github");
    expect(row?.kind).toBe("org_access");
    expect(row?.org).toBe("acme");
  });
});

describe("parseConnectLink — the access_restricted (attach) shape", () => {
  it("parses the agent-scoped switch link the gateway mints for an inactive account", () => {
    expect(
      parseConnectLink(
        "https://app.onecli.sh/w/abc/agents/agent-1/connections?attach=resend",
      ),
    ).toEqual({ provider: "resend", kind: "attach" });
  });

  it("refuses an agent-scoped attach link with no or a malformed provider", () => {
    expect(
      parseConnectLink(
        "https://app.onecli.sh/w/abc/agents/agent-1/connections?attach=%3Cx%3E",
      ),
    ).toBeNull();
    expect(
      parseConnectLink(
        "https://app.onecli.sh/w/abc/agents/agent-1/models?attach=resend",
      ),
    ).toBeNull();
  });

  it("parses the app-page link minted when the gateway knows no agent", () => {
    expect(
      parseConnectLink(
        "https://app.onecli.sh/w/abc/connections/apps/google-calendar",
      ),
    ).toEqual({ provider: "google-calendar", kind: "attach" });
  });

  it("refuses ids outside the alphabet and deeper paths", () => {
    expect(
      parseConnectLink("https://app.onecli.sh/connections/apps/G%20mail"),
    ).toBeNull();
    expect(
      parseConnectLink("https://app.onecli.sh/connections/apps/gmail/extra"),
    ).toBeNull();
  });

  it.each([
    ["a custom secret", "/w/abc/agents/agent-1/connections?tab=custom"],
    ["an LLM key", "/w/abc/agents/agent-1/models"],
    ["an app path with no registered app", "/w/abc/agents/agent-1/connections"],
  ])(
    "leaves the attach link for %s as plain prose (no card)",
    (_kind, path) => {
      // Only an app connection has an app to card; the gateway links every
      // other restricted credential to the agent page that attaches it.
      const href = `https://app.onecli.sh${path}`;
      expect(parseConnectLink(href)).toBeNull();
      expect(isCardConnectLink(href)).toBe(false);
    },
  );
});

describe("isCardConnectLink — the suppression predicate", () => {
  it("matches exactly what the card renders: shape AND catalog membership", () => {
    expect(isCardConnectLink(GMAIL_CONNECT_URL)).toBe(true);
    // Shape-valid but catalog-unknown: the card renders nothing, so the
    // prose link must survive — suppressing it would delete the only CTA.
    expect(
      isCardConnectLink(
        "https://app.onecli.sh/connections?connect=not-a-real-app-zzz",
      ),
    ).toBe(false);
    expect(isCardConnectLink("https://example.com/page")).toBe(false);
  });
});

describe("extractConnectSuggestions", () => {
  it("finds catalog apps in prose and dedupes by provider", () => {
    const text = `Connect it here: ${GMAIL_CONNECT_URL} — or later at https://app.onecli.sh/w/a/connections?connect=gmail`;
    const found = extractConnectSuggestions(text);
    expect(found).toHaveLength(1);
    expect(found[0]?.app.id).toBe("gmail");
    expect(found[0]?.agentName).toBe("Arik");
  });

  it("sheds trailing punctuation exactly like GFM autolinks", () => {
    // GFM links "…connect=gmail." as …connect=gmail (period outside). If the
    // raw scan kept the period the provider would fail the alphabet check —
    // prose suppressed, no card, CTA gone.
    for (const tail of [".", "...", "!", "?", ",", ";", ":", "**"]) {
      const found = extractConnectSuggestions(
        `See https://app.onecli.sh/w/a/connections?connect=gmail${tail} now`,
      );
      expect(found.map((f) => f.app.id)).toEqual(["gmail"]);
    }
  });

  it("drops providers the catalog does not know", () => {
    expect(
      extractConnectSuggestions(
        "https://app.onecli.sh/connections?connect=not-a-real-app-zzz",
      ),
    ).toHaveLength(0);
  });

  it("keeps one row per app, the attach row over the connect alternative", () => {
    // The access_restricted answer offers the switch, then a connect link for
    // the same app: the card must lead with Attach in either order, and keep
    // the app's place in the list.
    const attach =
      "https://app.onecli.sh/w/a/agents/ag-1/connections?attach=resend";
    const connect =
      "https://app.onecli.sh/w/a/connections?connect=resend&source=agent&agent_name=Bot";
    for (const text of [
      `Turn it on: ${attach}\nOr connect another: ${connect}`,
      `Connect: ${connect} or turn it on: ${attach}`,
    ]) {
      const rows = extractConnectSuggestions(
        `${text}\nAlso ${GMAIL_CONNECT_URL}`,
      );
      expect(rows.map((r) => [r.app.id, r.kind])).toEqual([
        ["resend", "attach"],
        ["gmail", "connect"],
      ]);
    }
  });
});
