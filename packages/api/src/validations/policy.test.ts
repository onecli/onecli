import { describe, expect, it } from "vitest";

import {
  createPolicyRuleSchema,
  isSessionPolicy,
  policyTargetSchema,
  sessionPolicySchema,
  updatePolicyRuleSchema,
} from "./policy";

describe("policyTargetSchema — connection targets", () => {
  it("accepts `tools` on a connection target (narrows which endpoints match)", () => {
    // A connection target's tools narrow which endpoints the rule matches
    // (empty = the connection's whole app); injection is unaffected.
    const parsed = policyTargetSchema.parse({
      kind: "connection",
      connectionId: "c1",
      tools: ["read_emails", "search_messages"],
    });
    expect(parsed).toEqual({
      kind: "connection",
      connectionId: "c1",
      tools: ["read_emails", "search_messages"],
    });
  });

  it("still accepts a connection target with no tools (the whole app)", () => {
    expect(
      policyTargetSchema.parse({ kind: "connection", connectionId: "c1" }),
    ).toEqual({ kind: "connection", connectionId: "c1" });
  });

  it("still accepts optional tools + connectionScope on app targets", () => {
    expect(
      policyTargetSchema.parse({
        kind: "app",
        provider: "gmail",
        connectionScope: "project",
      }),
    ).toEqual({ kind: "app", provider: "gmail", connectionScope: "project" });
  });

  it("accepts tools AND connectionScope together (the tools-picker shape)", () => {
    // The rule dialog's tools picker narrows an "all connections" app target to
    // specific tools — both fields present on the same target.
    expect(
      policyTargetSchema.parse({
        kind: "app",
        provider: "gmail",
        tools: ["search_messages", "read_message"],
        connectionScope: "project",
      }),
    ).toEqual({
      kind: "app",
      provider: "gmail",
      tools: ["search_messages", "read_message"],
      connectionScope: "project",
    });
  });
});

describe("sessionPolicySchema — granular per-resource scoping", () => {
  it("accepts a GitHub repositories policy", () => {
    expect(
      sessionPolicySchema.parse({ repositories: ["owner/repo", "owner/two"] }),
    ).toEqual({ repositories: ["owner/repo", "owner/two"] });
  });

  it("accepts a Dropbox folders policy", () => {
    expect(sessionPolicySchema.parse({ folders: ["/Team/Design"] })).toEqual({
      folders: ["/Team/Design"],
    });
  });

  it("accepts an empty list (empty = all resources)", () => {
    // Empty/absent means "the whole connection" — the enforcement layer treats
    // no items as no restriction. The schema still accepts it as a valid shape.
    expect(sessionPolicySchema.parse({ repositories: [] })).toEqual({
      repositories: [],
    });
  });

  it("rejects a mixed shape (repos AND folders on one object)", () => {
    // `.strict()` on each arm keeps the two provider axes mutually exclusive.
    expect(
      sessionPolicySchema.safeParse({ repositories: ["a/b"], folders: ["/x"] })
        .success,
    ).toBe(false);
  });

  it("rejects unknown keys and non-string items", () => {
    expect(sessionPolicySchema.safeParse({ buckets: ["a"] }).success).toBe(
      false,
    );
    expect(sessionPolicySchema.safeParse({ repositories: [1] }).success).toBe(
      false,
    );
    expect(sessionPolicySchema.safeParse({ repositories: [""] }).success).toBe(
      false,
    );
  });
});

describe("isSessionPolicy — object vs behavioral conditions", () => {
  it("treats an object as a session policy and an array as behavioral", () => {
    expect(isSessionPolicy({ repositories: ["a/b"] })).toBe(true);
    expect(isSessionPolicy({ folders: [] })).toBe(true);
    expect(
      isSessionPolicy([{ target: "body", operator: "contains", value: "x" }]),
    ).toBe(false);
    expect(isSessionPolicy(null)).toBe(false);
    expect(isSessionPolicy(undefined)).toBe(false);
  });
});

describe("createPolicyRuleSchema — conditions dual-use (behavioral | session policy)", () => {
  const base = { name: "r", action: "allow" as const };

  it("accepts a session policy alongside a connection target", () => {
    const parsed = createPolicyRuleSchema.parse({
      ...base,
      targets: [{ kind: "connection", connectionId: "c1" }],
      conditions: { repositories: ["owner/repo"] },
    });
    expect(parsed.conditions).toEqual({ repositories: ["owner/repo"] });
  });

  it("rejects a session policy without any connection target", () => {
    // A session policy scopes a connection's injected credential — meaningless
    // (and rejected) without a connection target (the `sessionPolicyNeedsConnection`
    // refine).
    const res = createPolicyRuleSchema.safeParse({
      ...base,
      targets: [
        { kind: "app", provider: "github", connectionScope: "project" },
      ],
      conditions: { repositories: ["owner/repo"] },
    });
    expect(res.success).toBe(false);
  });

  it("still accepts behavioral (body-contains) conditions with any target", () => {
    // An array is behavioral — it needs no connection target.
    const parsed = createPolicyRuleSchema.parse({
      ...base,
      targets: [{ kind: "network", hostPattern: "api.example.com" }],
      conditions: [{ target: "body", operator: "contains", value: "secret" }],
    });
    expect(Array.isArray(parsed.conditions)).toBe(true);
  });

  it("rejects garbage conditions (neither a behavioral array nor a session policy)", () => {
    expect(
      createPolicyRuleSchema.safeParse({
        ...base,
        targets: [{ kind: "connection", connectionId: "c1" }],
        conditions: "nonsense",
      }).success,
    ).toBe(false);
    expect(
      createPolicyRuleSchema.safeParse({
        ...base,
        targets: [{ kind: "connection", connectionId: "c1" }],
        conditions: { repositories: [123] },
      }).success,
    ).toBe(false);
  });

  it("still enforces the behavioral .max(10) through the dual-use union", () => {
    // The union must not let the behavioral-array bound leak — 11 conditions is
    // rejected (it's not a valid session-policy object either).
    const many = Array.from({ length: 11 }, () => ({
      target: "body" as const,
      operator: "contains" as const,
      value: "x",
    }));
    expect(
      createPolicyRuleSchema.safeParse({
        ...base,
        targets: [{ kind: "network", hostPattern: "h" }],
        conditions: many,
      }).success,
    ).toBe(false);
  });

  it("accepts a session policy alongside MIXED targets (connection + network)", () => {
    const parsed = createPolicyRuleSchema.parse({
      ...base,
      targets: [
        { kind: "connection", connectionId: "c1" },
        { kind: "network", hostPattern: "api.example.com" },
      ],
      conditions: { repositories: ["owner/repo"] },
    });
    expect(parsed.conditions).toEqual({ repositories: ["owner/repo"] });
  });
});

describe("updatePolicyRuleSchema — conditions", () => {
  it("accepts an object session policy", () => {
    expect(
      updatePolicyRuleSchema.parse({ conditions: { folders: ["/x"] } })
        .conditions,
    ).toEqual({ folders: ["/x"] });
  });

  it("accepts null to clear conditions", () => {
    // A partial update may clear a rule's conditions entirely.
    expect(updatePolicyRuleSchema.parse({ conditions: null }).conditions).toBe(
      null,
    );
  });
});
