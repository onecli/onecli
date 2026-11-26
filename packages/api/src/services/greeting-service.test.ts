import { describe, expect, it } from "vitest";
import { buildGreetingInstruction, emailForGreeting } from "./greeting-service";

describe("buildGreetingInstruction", () => {
  const text = buildGreetingInstruction({
    email: "alex@example.com",
    agentName: "Donna",
  });

  it("is a brief for the agent's own words, never a script to recite", () => {
    // The welcome must be the agent's writing: words it never chose must
    // not land in its bubble.
    expect(text).toContain("in your own words");
    expect(text).not.toMatch(/word for word|exactly the message/i);
  });

  it("names the person and the agent, and points at the Gmail button", () => {
    expect(text).toContain("alex@example.com");
    expect(text).toContain("as Donna");
    expect(text).toContain("ask what their name is");
    expect(text).toContain("connecting their Gmail");
  });

  it("keeps the first message plain: no links, other apps or tools", () => {
    expect(text).toContain("do not use tools");
    expect(text).toContain("do not name other apps");
    expect(text).not.toMatch(/GitHub|Slack/);
  });

  it("still briefs when no email is known", () => {
    expect(
      buildGreetingInstruction({ email: null, agentName: "Donna" }),
    ).not.toContain("their email is");
  });
});

describe("emailForGreeting", () => {
  it("keeps a normal address", () => {
    expect(emailForGreeting("alex.kim42@example.com")).toBe(
      "alex.kim42@example.com",
    );
  });

  it("strips control characters and whitespace", () => {
    expect(emailForGreeting(" a\u0007b@ex ample.com ")).toBe("ab@example.com");
  });

  it("refuses empty, non-email and overlong input", () => {
    expect(emailForGreeting(null)).toBeNull();
    expect(emailForGreeting("not-an-email")).toBeNull();
    expect(emailForGreeting(`${"a".repeat(250)}@x.io`)).toBeNull();
  });
});
