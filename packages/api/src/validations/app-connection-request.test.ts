import { describe, expect, it } from "vitest";
import { requestAppConnectionArgsSchema } from "./app-connection-request";

describe("requestAppConnectionArgsSchema", () => {
  it("takes one bounded, trimmed app name", () => {
    expect(requestAppConnectionArgsSchema.parse({ app: "  jira " })).toEqual({
      app: "jira",
    });
    expect(
      requestAppConnectionArgsSchema.safeParse({ app: "x".repeat(65) }).success,
    ).toBe(false);
    expect(
      requestAppConnectionArgsSchema.safeParse({ app: "  " }).success,
    ).toBe(false);
    expect(requestAppConnectionArgsSchema.safeParse({}).success).toBe(false);
  });

  it("refuses any other argument, so no caller can name another agent", () => {
    expect(
      requestAppConnectionArgsSchema.safeParse({ app: "jira", agentId: "ag-2" })
        .success,
    ).toBe(false);
  });
});
