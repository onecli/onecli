import { describe, expect, it } from "vitest";
import {
  EXPIRY_WARNING_MS,
  expiryNotice,
  vaultStatusBadge,
} from "./vault-status-badge";

describe("vaultStatusBadge", () => {
  it.each([
    [{ lastError: null, isReady: true }, "Connected", "ok"],
    [{ lastError: null, isReady: false }, "Paired", "ok"],
    [{ lastError: "boom", isReady: false }, "Error", "error"],
    // Whatever the cause, a connection OneCLI can't use reads the same.
    [
      { lastError: "denied", reason: "connection_failed", isReady: false },
      "Can't connect",
      "error",
    ],
    [
      { lastError: null, reason: "no_records", isReady: true },
      "No records shared",
      "warn",
    ],
    // An error outranks "nothing shared": the check that counted them failed.
    [
      { lastError: "boom", reason: "no_records", isReady: false },
      "Error",
      "error",
    ],
  ] as const)("%o reads %s", (input, label, tone) => {
    expect(vaultStatusBadge(input)).toEqual({ label, tone });
  });
});

describe("expiryNotice", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();

  it("is nothing without a date, or with a malformed one", () => {
    expect(expiryNotice(null, now)).toBeNull();
    expect(expiryNotice(undefined, now)).toBeNull();
    expect(expiryNotice("not a date", now)).toBeNull();
  });

  it("is an error once the date has passed", () => {
    expect(expiryNotice(at(-1000), now)?.tone).toBe("error");
    expect(expiryNotice(at(-1000), now)?.text).toMatch(/expired on/);
  });

  it("warns within a week", () => {
    expect(expiryNotice(at(EXPIRY_WARNING_MS - 1000), now)?.tone).toBe("warn");
  });

  it("just informs further out", () => {
    const notice = expiryNotice(at(EXPIRY_WARNING_MS * 4), now);
    expect(notice?.tone).toBe("ok");
    expect(notice?.text).toMatch(/expires on/);
  });
});
