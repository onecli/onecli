import { z } from "zod";
import { sessionPolicySchema } from "./policy";

// ── Attach-model grants request shapes (plans/project-attach-model.md §4.3) ──
// A connection grant is either the uncustomized whole-app attach or an explicit
// per-tool tri-state (allow / ask; the rest compiles to blocked). Structural
// laws live here for clean 422s; catalog membership and the plan gate are the
// service's job.
//
// `resources` is the grant's session policy (the "Resources" restriction —
// repositories/folders the injected credential may reach), tri-state:
// ABSENT = preserve whatever the stack already carries (legacy clients and
// tools-only dialog saves stay untouched), NULL = clear, OBJECT = set (the
// service validates it through the edition's policy validator).

export const connectionGrantSchema = z
  .discriminatedUnion("access", [
    z.object({
      access: z.literal("full"),
      resources: sessionPolicySchema.nullish(),
    }),
    z.object({
      access: z.literal("custom"),
      allow: z.array(z.string().min(1).max(255)).max(200),
      ask: z.array(z.string().min(1).max(255)).max(200),
      resources: sessionPolicySchema.nullish(),
    }),
  ])
  .refine(
    (v) => v.access === "full" || v.allow.length + v.ask.length > 0,
    // The attached ⇔ allow∪ask ≠ ∅ invariant: an all-blocked grant is a detach.
    {
      message:
        "Custom access needs at least one allowed or approval tool — detach instead.",
    },
  )
  .refine(
    (v) => v.access === "full" || !v.allow.some((tool) => v.ask.includes(tool)),
    { message: "A tool can't be both always-allowed and require approval." },
  );
export type ConnectionGrantInput = z.infer<typeof connectionGrantSchema>;

/** GET /v1/agents `include` projections — absent = the plain agent list. */
export const agentsIncludeSchema = z.enum(["grants-summary"]).optional();
