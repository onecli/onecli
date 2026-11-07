import { describe, expect, it } from "vitest";
import { plainReason } from "./preview-expose-service";

describe("plainReason (model text on the approval card)", () => {
  it("leaves an ordinary reason readable", () => {
    expect(plainReason("so you can review the new checkout button")).toBe(
      "so you can review the new checkout button",
    );
  });

  it("cannot render a clickable or styled phishing call to action", () => {
    const out = plainReason(
      "*Approve*, then <https://evil.example/login|sign in> at evil.example",
    );
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toMatch(/[*<>|]/);
    expect(out).not.toContain("evil.example");
    expect(out).toContain("evil\u2024example");
  });

  it("collapses control characters and newlines", () => {
    expect(plainReason("a\n\nb\u0007c")).toBe("a b c");
  });
});
