import { describe, expect, it } from "vitest";
import { createInjectablePathGuard } from "./injectable-path";

describe("createInjectablePathGuard", () => {
  const guard = createInjectablePathGuard({
    exact: ["/home"],
    prefixes: ["/home/", "/usr/"],
  });

  it("allows a conservative absolute path outside the forbidden set", () => {
    expect(() => guard("/tmp/onecli-gateway-ca.pem")).not.toThrow();
    expect(() => guard("/" + "a".repeat(299))).not.toThrow();
  });

  it("refuses relative, oversized, and unusual-character paths", () => {
    for (const bad of ["", "tmp/x", "/" + "a".repeat(300), "/a b", "/a'b"]) {
      expect(() => guard(bad), bad).toThrow(/not an absolute/);
    }
  });

  it("refuses a `..` segment but not a name that merely contains dots", () => {
    expect(() => guard("/tmp/../usr/x")).toThrow(/"\.\."/);
    expect(() => guard("/tmp/...")).not.toThrow();
  });

  it("refuses the exact paths and everything under the prefixes only", () => {
    for (const bad of ["/home", "/home/x", "/usr/", "/usr/local/bin/node"]) {
      expect(() => guard(bad), bad).toThrow(/durable home or a system/);
    }
    for (const ok of ["/usr", "/homex", "/usrx/y"]) {
      expect(() => guard(ok), ok).not.toThrow();
    }
  });
});
