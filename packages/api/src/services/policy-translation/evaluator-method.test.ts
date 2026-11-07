import { describe, expect, it } from "vitest";
import { methodAllows } from "./evaluator";

// Mirror of the gateway's `MethodFilter` (types.rs `method_filter_tests`).
describe("methodAllows", () => {
  it("empty / absent narrowing allows every method", () => {
    for (const raw of [null, undefined, "", " ", "!"]) {
      expect(methodAllows(raw, "DELETE")).toBe(true);
    }
  });

  it("GET,HEAD and !GET,HEAD partition every method, case-insensitively", () => {
    for (const m of [
      "GET",
      "get",
      "HEAD",
      "POST",
      "PATCH",
      "PUT",
      "DELETE",
      "OPTIONS",
    ]) {
      expect(methodAllows("GET,HEAD", m)).not.toBe(
        methodAllows("!GET,HEAD", m),
      );
    }
    expect(methodAllows("get, head", "HEAD")).toBe(true);
    expect(methodAllows("!GET,HEAD", "post")).toBe(true);
  });
});
