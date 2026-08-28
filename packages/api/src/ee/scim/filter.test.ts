import { describe, expect, it } from "vitest";
import { parseEqFilter, parseSupportedEqFilter } from "./filter";
import { ScimError } from "./errors";

describe("parseEqFilter", () => {
  it("parses the canonical IdP probes", () => {
    // Okta /Users lookup
    expect(parseEqFilter('userName eq "jane@acme.com"')).toEqual({
      attribute: "username",
      value: "jane@acme.com",
    });
    // Okta Push Groups lookup
    expect(parseEqFilter('displayName eq "Engineering"')).toEqual({
      attribute: "displayname",
      value: "Engineering",
    });
    // Entra Test Connection probes a random GUID
    expect(
      parseEqFilter('userName eq "77c4b9e5-5a3d-4b2e-9f1a-000000000000"'),
    ).toEqual({
      attribute: "username",
      value: "77c4b9e5-5a3d-4b2e-9f1a-000000000000",
    });
  });

  it("is case-insensitive on attribute and operator, tolerant of spacing", () => {
    expect(parseEqFilter('  UserName   EQ   "A@X.com"  ')).toEqual({
      attribute: "username",
      value: "A@X.com", // value case is preserved — callers decide semantics
    });
  });

  it("unescapes quoted values", () => {
    expect(parseEqFilter('displayName eq "Say \\"hi\\" \\\\ team"')).toEqual({
      attribute: "displayname",
      value: 'Say "hi" \\ team',
    });
  });

  it.each([
    ["userName eq unquoted", "unquoted value"],
    ['userName co "partial"', "unsupported operator"],
    ['userName eq "a" and active eq "true"', "compound filter"],
    ["", "empty"],
  ])("rejects %s as invalidFilter", (filter) => {
    expect(() => parseEqFilter(filter)).toThrowError(ScimError);
    try {
      parseEqFilter(filter);
    } catch (err) {
      expect(err).toMatchObject({ status: 400, scimType: "invalidFilter" });
    }
  });
});

describe("parseSupportedEqFilter", () => {
  it("passes supported attributes through", () => {
    expect(
      parseSupportedEqFilter('userName eq "a@x.com"', ["username"], "hint"),
    ).toEqual({ attribute: "username", value: "a@x.com" });
  });

  it("rejects unsupported attributes with the guidance hint", () => {
    // /Users has no stored externalId — the documented limitation
    try {
      parseSupportedEqFilter(
        'externalId eq "abc"',
        ["username"],
        "Match users by userName (email).",
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ status: 400, scimType: "invalidFilter" });
      expect((err as ScimError).message).toContain(
        "Match users by userName (email).",
      );
    }
  });
});
