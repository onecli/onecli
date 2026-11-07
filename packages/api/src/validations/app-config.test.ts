import { describe, expect, it } from "vitest";
import { parseConfigBody } from "./app-config";

// The config body is validated against the app's own field definitions. The
// dialog renders `options` fields as a fixed choice, but the body is still
// client-supplied: whatever a field's shape, only declared names pass, and
// the value is accepted as a string for the app's own code (e.g. Salesforce's
// `loginOrigin`) to switch on and refuse.
const FIELDS = [
  { name: "clientId" },
  { name: "clientSecret" },
  { name: "environment" },
];

describe("parseConfigBody", () => {
  it("keeps declared fields and strips the rest", () => {
    expect(
      parseConfigBody(
        {
          clientId: "key",
          clientSecret: "secret",
          environment: "sandbox",
          enabled: "true",
          workspaceId: "other",
        },
        FIELDS,
      ),
    ).toEqual({
      clientId: "key",
      clientSecret: "secret",
      environment: "sandbox",
    });
  });

  it("accepts a partial body (an empty secret means keep current)", () => {
    expect(parseConfigBody({ environment: "production" }, FIELDS)).toEqual({
      environment: "production",
    });
  });

  it("rejects anything that is not a string record", () => {
    for (const body of [
      null,
      "environment=sandbox",
      ["sandbox"],
      { environment: 1 },
      { environment: ["sandbox"] },
      { environment: { value: "sandbox" } },
      { environment: null },
    ]) {
      expect(parseConfigBody(body, FIELDS), JSON.stringify(body)).toBeNull();
    }
  });
});
