import { describe, expect, it } from "vitest";
import {
  SCIM_PATCH_SCHEMA,
  coerceScimBoolean,
  parsePatchBody,
  parseScimPath,
} from "./patch";
import { ScimError } from "./errors";

const patchBody = (operations: unknown[]) => ({
  schemas: [SCIM_PATCH_SCHEMA],
  Operations: operations,
});

describe("parsePatchBody", () => {
  it("parses an Entra deactivate — capitalized op + boolean string", () => {
    // Shape from Microsoft's provisioning docs
    const ops = parsePatchBody(
      patchBody([{ op: "Replace", path: "active", value: "False" }]),
    );
    expect(ops).toEqual([
      { op: "replace", path: { base: "active" }, value: "False" },
    ]);
    expect(coerceScimBoolean(ops[0]!.value)).toBe(false);
  });

  it("parses a no-path replace with a value object", () => {
    const ops = parsePatchBody(
      patchBody([
        { op: "replace", value: { active: "True", displayName: "Jane D" } },
      ]),
    );
    expect(ops[0]).toEqual({
      op: "replace",
      value: { active: "True", displayName: "Jane D" },
    });
  });

  it("accepts case-insensitive keys (Operations/op/path/value)", () => {
    const ops = parsePatchBody({
      schemas: [SCIM_PATCH_SCHEMA],
      operations: [{ Op: "Add", Path: "members", Value: [{ value: "u1" }] }],
    });
    expect(ops).toEqual([
      { op: "add", path: { base: "members" }, value: [{ value: "u1" }] },
    ]);
  });

  it("parses both Okta member-remove syntaxes", () => {
    // Syntax 1: path filter
    const filtered = parsePatchBody(
      patchBody([{ op: "remove", path: 'members[value eq "usr-1"]' }]),
    );
    expect(filtered[0]).toEqual({
      op: "remove",
      path: {
        base: "members",
        filter: { attribute: "value", value: "usr-1" },
      },
      value: undefined,
    });

    // Syntax 2: op-level value array
    const valued = parsePatchBody(
      patchBody([
        { op: "remove", path: "members", value: [{ value: "usr-1" }] },
      ]),
    );
    expect(valued[0]).toEqual({
      op: "remove",
      path: { base: "members" },
      value: [{ value: "usr-1" }],
    });
  });

  it.each([
    ["missing schema", { Operations: [{ op: "replace" }] }],
    [
      "wrong schema",
      { schemas: ["urn:nope"], Operations: [{ op: "replace" }] },
    ],
    ["empty operations", patchBody([])],
    ["unknown op", patchBody([{ op: "merge", value: {} }])],
    ["non-object body", "not an object"],
  ])("rejects %s as invalidSyntax", (_label, body) => {
    try {
      parsePatchBody(body);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ScimError);
      expect(err).toMatchObject({ status: 400, scimType: "invalidSyntax" });
    }
  });
});

describe("parseScimPath", () => {
  it("lowercases and keeps dotted sub-attributes", () => {
    expect(parseScimPath("name.givenName")).toEqual({
      base: "name.givenname",
    });
  });

  it("parses a filter with a trailing sub-attribute", () => {
    expect(parseScimPath('members[value eq "u-1"].display')).toEqual({
      base: "members",
      filter: { attribute: "value", value: "u-1" },
      subAttribute: "display",
    });
  });

  it("rejects malformed paths as invalidPath", () => {
    try {
      parseScimPath("members[value gt 3]");
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ status: 400, scimType: "invalidPath" });
    }
  });
});

describe("coerceScimBoolean", () => {
  it.each([
    [true, true],
    [false, false],
    ["True", true],
    ["False", false],
    ["true", true],
    ["FALSE", false],
  ] as const)("%s → %s", (input, expected) => {
    expect(coerceScimBoolean(input)).toBe(expected);
  });

  it("returns null for non-booleans (never corrupts real strings)", () => {
    expect(coerceScimBoolean("Truely not")).toBeNull();
    expect(coerceScimBoolean(1)).toBeNull();
    expect(coerceScimBoolean(undefined)).toBeNull();
  });
});
