import { describe, expect, it } from "vitest";
import { gatewayErrorMessage } from "./keepersecurity";

describe("gatewayErrorMessage", () => {
  it("passes the gateway's own message through", () => {
    expect(
      gatewayErrorMessage(
        "/records",
        400,
        "cannot list keepersecurity records: denied",
      ),
    ).toBe("cannot list keepersecurity records: denied");
  });

  it("names the failing call when the body has no message", () => {
    const msg = gatewayErrorMessage("/records", 400, undefined);
    expect(msg).toContain("Keeper records");
    expect(msg).toContain("400");
    expect(msg).toMatch(/restart the gateway/);
  });

  it("distinguishes a record's fields from the record list", () => {
    expect(gatewayErrorMessage("/records/abc/fields", 500, {})).toContain(
      "this record’s fields",
    );
  });

  it("points an auth failure at signing in, not the gateway", () => {
    expect(gatewayErrorMessage("/records", 401, undefined)).toMatch(
      /sign in again/,
    );
  });

  it("ignores a non-string or blank error", () => {
    expect(gatewayErrorMessage("/status", 400, { message: "x" })).toContain(
      "Keeper status",
    );
    expect(gatewayErrorMessage("/status", 400, "  ")).toContain(
      "Keeper status",
    );
  });
});
