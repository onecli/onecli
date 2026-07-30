import { describe, expect, it } from "vitest";
import { agentsIncludeSchema, connectionGrantSchema } from "./grants";

// Structural laws of the grant body: the discriminated access union, the
// attached ⇔ allow∪ask ≠ ∅ invariant, and tri-state disjointness. Catalog
// membership and the plan gate are service-level (grants-service.test.ts).

describe("connectionGrantSchema", () => {
  it("accepts the uncustomized whole-app attach", () => {
    expect(connectionGrantSchema.parse({ access: "full" })).toEqual({
      access: "full",
    });
  });

  it("accepts a custom tri-state with disjoint sets", () => {
    expect(
      connectionGrantSchema.parse({
        access: "custom",
        allow: ["read_message"],
        ask: ["send_message"],
      }),
    ).toMatchObject({ access: "custom" });
  });

  it("rejects an all-empty custom grant — that's a detach", () => {
    const result = connectionGrantSchema.safeParse({
      access: "custom",
      allow: [],
      ask: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("detach instead");
    }
  });

  it("rejects a tool in both allow and ask", () => {
    const result = connectionGrantSchema.safeParse({
      access: "custom",
      allow: ["send_message"],
      ask: ["send_message"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown access value and a missing body", () => {
    expect(connectionGrantSchema.safeParse({ access: "nope" }).success).toBe(
      false,
    );
    expect(connectionGrantSchema.safeParse(null).success).toBe(false);
  });
});

describe("agentsIncludeSchema", () => {
  it("accepts grants-summary and absence, rejects anything else", () => {
    expect(agentsIncludeSchema.safeParse("grants-summary").success).toBe(true);
    expect(agentsIncludeSchema.safeParse(undefined).success).toBe(true);
    expect(agentsIncludeSchema.safeParse("everything").success).toBe(false);
  });
});
