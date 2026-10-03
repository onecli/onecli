import { describe, expect, it } from "vitest";
import { agentConnectionSchema } from "./transport";
import { cleanLabel, isBareHostname } from "./text";

describe("cleanLabel", () => {
  it("drops control characters, folds every whitespace run (line separators included) to one space, clamps", () => {
    expect(cleanLabel("  Ada\u0007 \n\tLovelace\u2028\u2029 ")).toBe(
      "Ada Lovelace",
    );
    // The API's long-standing rule, kept exactly: a Unicode separator is
    // whitespace (a word break), a C0 control such as the newline is dropped.
    // Neither can open a new line.
    expect(cleanLabel("Ada\u2028Bee")).toBe("Ada Bee");
    expect(cleanLabel("Ada\nBee")).toBe("AdaBee");
    expect(cleanLabel("N".repeat(500), 80)).toHaveLength(80);
    expect(cleanLabel("", 10)).toBe("");
  });
});

describe("isBareHostname", () => {
  it("accepts a lowercase dotted LDH host and nothing URL-shaped", () => {
    expect(isBareHostname("acme-prod.snowflakecomputing.com")).toBe(true);
    for (const bad of [
      "",
      "localhost",
      "Acme.My.Salesforce.com",
      "evil.test/phish",
      "user@acme.my.salesforce.com",
      "acme.my.salesforce.com:443",
      "acme.my.salesforce.com?x=1",
      "acme.my.salesforce.com#frag",
      "-acme.my.salesforce.com",
      ".my.salesforce.com",
      `${"a".repeat(250)}.com`,
    ]) {
      expect(isBareHostname(bad), bad).toBe(false);
    }
  });
});

describe("agentConnectionSchema", () => {
  const base = { provider: "salesforce", name: "Salesforce", label: null };

  it("accepts a bare bound host or null, and refuses anything else", () => {
    expect(
      agentConnectionSchema.safeParse({
        ...base,
        host: "acme.my.salesforce.com",
      }).success,
    ).toBe(true);
    expect(
      agentConnectionSchema.safeParse({ ...base, host: null }).success,
    ).toBe(true);
    // The host is rendered as `https://<host>` for the agent to call, so a
    // path, userinfo or port must never cross the wire.
    for (const host of [
      "evil.test/phish",
      "user@acme.my.salesforce.com",
      "acme.my.salesforce.com:8443",
      "",
    ]) {
      expect(
        agentConnectionSchema.safeParse({ ...base, host }).success,
        host,
      ).toBe(false);
    }
  });
});
