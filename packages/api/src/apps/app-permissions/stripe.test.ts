import { describe, expect, it } from "vitest";
import { stripePermissions } from "./stripe";
import { allGroupTools } from "./types";

const group = (category: "read" | "write") => {
  const found = stripePermissions.groups.find((g) => g.category === category);
  if (!found) throw new Error(`stripe has no ${category} group`);
  return found;
};

// Stripe serves TWO API namespaces. `/v2` is not a future concern: it already
// carries money-moving writes (`/v2/money_management/payout_methods`) and
// account mutations (`/v2/core/accounts`). A `/v1/*`-only write wildcard would
// present a "require approval for every write" toggle that silently ignores
// all of them.
//
// write-wildcard-coverage.test.ts cannot catch this: it only proves the
// wildcard covers the tools that ARE enumerated, and every enumerated Stripe
// tool is `/v1`. So pin the namespace span directly.
describe("stripe wildcards span both API namespaces", () => {
  it.each(["read", "write"] as const)(
    "%s wildcard covers /v1 and /v2",
    (category) => {
      const wildcard = group(category).wildcard;
      expect(wildcard).toBeDefined();
      const patterns = [
        wildcard!.pathPattern,
        ...(wildcard!.aliasPatterns ?? []),
      ];
      expect(patterns).toContain("/v1/*");
      expect(patterns).toContain("/v2/*");
    },
  );

  it("the write gate covers the money-moving endpoints by name", () => {
    const writeGroup = group("write");
    const ids = writeGroup.tools.map((t) => t.id);
    // These are the operations a user most needs to be able to gate or block.
    for (const id of [
      "create_refund",
      "create_payout",
      "cancel_subscription",
      "create_charge",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("every enumerated tool is a GET in read and a mutation in write", () => {
    for (const category of ["read", "write"] as const) {
      for (const tool of allGroupTools(group(category))) {
        const methods = tool.methods ?? (tool.method ? [tool.method] : []);
        expect(methods.length).toBeGreaterThan(0);
        for (const method of methods) {
          if (category === "read") expect(method).toBe("GET");
          else expect(["POST", "DELETE"]).toContain(method);
        }
      }
    }
  });
});
