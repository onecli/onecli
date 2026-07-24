import { z } from "zod";
import { ruleConditionSchema } from "./policy-rule";

// ── Unified policy engine (policy_rules_v2) request shapes ──────────────────
// Discriminated unions mirror the DB CHECK constraints (one-principal per
// identity row, kind-shaped targets), so malformed input is rejected with 422
// before it reaches the database.

/** A rule names exactly one principal per identity — a uniform {type, id}. */
export const policyIdentitySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent"), id: z.string().min(1) }),
  z.object({ type: z.literal("agentGroup"), id: z.string().min(1) }),
  z.object({ type: z.literal("user"), id: z.string().min(1) }),
  z.object({ type: z.literal("group"), id: z.string().min(1) }),
]);
export type PolicyIdentityInput = z.infer<typeof policyIdentitySchema>;

const methodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** A target's populated fields are shaped by `kind` (the kind_shape CHECK). */
export const policyTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("app"),
    provider: z.string().min(1).max(255),
    tools: z.array(z.string().min(1)).max(100).optional(),
    // Step 8: when set, this app target injects ALL the agent's connections of
    // `provider` at the given level ("all connections"); absent = the
    // app-permission block/allow rule (no injection). `assertTargetsValid` fences
    // the level (a project rule can't scope to `organization`).
    connectionScope: z.enum(["organization", "project"]).optional(),
  }),
  z.object({
    kind: z.literal("connection"),
    connectionId: z.string().min(1),
    // `tools` narrow WHICH endpoints the rule matches (the engine decodes a
    // connection target to its provider's app, honoring these tools); empty =
    // the provider's whole app. Injection is independent — it always injects the
    // whole connection, tools or not.
    tools: z.array(z.string().min(1)).max(100).optional(),
  }),
  z.object({
    kind: z.literal("secret"),
    // A secret target names EITHER a specific `secretId` OR a `secretScope`
    // ("all secrets at that level"). Both are optional here; `assertTargetsValid`
    // enforces exactly-one (a clean 422) and the level fence, mirroring `app`.
    secretId: z.string().min(1).optional(),
    secretScope: z.enum(["organization", "project"]).optional(),
  }),
  z.object({
    kind: z.literal("network"),
    hostPattern: z.string().min(1).max(1000),
    pathPattern: z.string().max(1000).optional(),
    method: methodSchema.optional(),
  }),
]);
export type PolicyTargetInput = z.infer<typeof policyTargetSchema>;

export const policyActionSchema = z.enum(["allow", "block"]);
const rateLimitWindowSchema = z.enum(["minute", "hour", "day"]);

// Granular per-resource scoping (the "session policy") a CONNECTION target can
// carry: an object keyed by the provider's resource axis — GitHub → repos,
// Dropbox → folders. It rides in `conditions` (the exact shape the equipment
// materialization persists and the gateway's `granular_access` guard reads,
// source-agnostically), distinct from the behavioral RuleCondition[] (body
// contains X) the block/allow engine evaluates. Structural bounds only; the
// per-provider deep checks (repos exist on the installation, absolute Dropbox
// paths) + the entitlement gate run in the EE policy validator. Empty/absent = all.
export const sessionPolicySchema = z.union([
  z
    .object({ repositories: z.array(z.string().min(1).max(400)).max(1000) })
    .strict(),
  z.object({ folders: z.array(z.string().min(1).max(1024)).max(100) }).strict(),
]);
export type SessionPolicyInput = z.infer<typeof sessionPolicySchema>;

/** A rule's `conditions`: EITHER behavioral (body-contains) rules OR a connection
 * target's granular session policy (repos/folders). An array is behavioral, an
 * object is a session policy; they never mix on one rule. */
const ruleConditionsSchema = z.union([
  z.array(ruleConditionSchema).max(10),
  sessionPolicySchema,
]);

export const isSessionPolicy = (c: unknown): c is SessionPolicyInput =>
  c != null && typeof c === "object" && !Array.isArray(c);

const ruleShape = {
  name: z.string().trim().min(1).max(255),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().optional(),
  action: policyActionSchema,
  // Modifiers on an Allow; empty identities = "any agent". A rule must name at
  // least one target — the service rejects an empty list (see `createPolicyRule`):
  // an empty target set matches NOTHING at the gateway (fail-closed), never "any".
  rateLimit: z.number().int().min(1).max(1_000_000).optional(),
  rateLimitWindow: rateLimitWindowSchema.optional(),
  requireApproval: z.boolean().optional(),
  conditions: ruleConditionsSchema.optional(),
  identities: z.array(policyIdentitySchema).max(100).optional(),
  targets: z.array(policyTargetSchema).max(100).optional(),
};

const modifiersRequireAllow = {
  check: (d: {
    action: "allow" | "block";
    rateLimit?: number | null;
    requireApproval?: boolean | null;
    rateLimitWindow?: string | null;
  }) =>
    d.action !== "block" ||
    (d.rateLimit == null && d.rateLimitWindow == null && !d.requireApproval),
  message: "rate-limit and approval modifiers require action = allow",
};
const rateLimitPaired = {
  check: (d: { rateLimit?: number | null; rateLimitWindow?: string | null }) =>
    (d.rateLimit == null) === (d.rateLimitWindow == null),
  message: "rateLimit and rateLimitWindow must be provided together",
};
const sessionPolicyNeedsConnection = {
  // A session policy (object `conditions`) scopes a connection's injected
  // credential — it's meaningless without a connection target.
  check: (d: { conditions?: unknown; targets?: { kind: string }[] }) =>
    !isSessionPolicy(d.conditions) ||
    (d.targets ?? []).some((t) => t.kind === "connection"),
  message:
    "resource scoping (repositories/folders) requires a connection target",
};

export const createPolicyRuleSchema = z
  .object(ruleShape)
  .refine(modifiersRequireAllow.check, {
    message: modifiersRequireAllow.message,
  })
  .refine(rateLimitPaired.check, { message: rateLimitPaired.message })
  .refine(sessionPolicyNeedsConnection.check, {
    message: sessionPolicyNeedsConnection.message,
  });
export type CreatePolicyRuleInput = z.infer<typeof createPolicyRuleSchema>;

// Every field optional; `null` clears a nullable field. `action`-vs-modifier
// consistency is re-checked in the service against the merged rule, since a
// partial update may change only one side.
export const updatePolicyRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(1000).nullable().optional(),
    enabled: z.boolean().optional(),
    action: policyActionSchema.optional(),
    rateLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
    rateLimitWindow: rateLimitWindowSchema.nullable().optional(),
    requireApproval: z.boolean().optional(),
    conditions: ruleConditionsSchema.nullable().optional(),
    identities: z.array(policyIdentitySchema).max(100).optional(),
    targets: z.array(policyTargetSchema).max(100).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdatePolicyRuleInput = z.infer<typeof updatePolicyRuleSchema>;

export const reorderPolicyRulesSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});

export const setDefaultRuleSchema = z.object({
  action: policyActionSchema,
});

export const policyStatusSchema = z.enum(["draft", "published"]);
