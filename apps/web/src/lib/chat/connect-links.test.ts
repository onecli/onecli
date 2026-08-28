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

describe("parseConnectLink — the access_restricted (attach) shape", () => {
  it("parses the manage URL the gateway mints when the agent lacks a grant", () => {
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
});
