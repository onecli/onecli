import { z } from "zod";

// ── Attach-model grants request shapes (plans/project-attach-model.md §4.3) ──
// A connection grant is either the uncustomized whole-app attach or an explicit
// per-tool tri-state (allow / ask; the rest compiles to blocked). Structural
// laws live here for clean 422s; catalog membership and the plan gate are the
// service's job.

export const connectionGrantSchema = z
  .discriminatedUnion("access", [
    z.object({ access: z.literal("full") }),
    z.object({
      access: z.literal("custom"),
      allow: z.array(z.string().min(1).max(255)).max(200),
      ask: z.array(z.string().min(1).max(255)).max(200),
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
