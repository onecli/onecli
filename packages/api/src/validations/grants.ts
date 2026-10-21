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

// Requests outside a catalog: allowed, needs approval, or blocked.
const unlistedChoiceSchema = z.enum(["allow", "ask", "never"]);
export type UnlistedChoice = z.infer<typeof unlistedChoiceSchema>;

export const connectionGrantSchema = z
  .discriminatedUnion("access", [
    z.object({
      access: z.literal("full"),
      resources: sessionPolicySchema.nullish(),
    }),
    // The product-default attach (the attach toggles, the connecting agent's
    // grant): the server resolves it per provider (`defaultConnectionGrant`):
    // read tools allowed, write tools and requests outside the tool list
    // needing approval (full access for an app with no tool list). Never
    // stored as such, so it never reads back.
    z.object({
      access: z.literal("default"),
      resources: sessionPolicySchema.nullish(),
    }),
    z.object({
      access: z.literal("custom"),
      allow: z.array(z.string().min(1).max(255)).max(200),
      ask: z.array(z.string().min(1).max(255)).max(200),
      // What happens to requests the catalog does not describe, split by
      // method: "All other reads" (GET/HEAD) and "All other writes" (the
      // rest). ABSENT = keep what the grant already says (the provider's
      // default on a first customization: needs approval, never for a
      // catalog with `unlisted: "block"`), so a tools-only save from an older
      // client never resets them. A catalog with `unlisted: "block"` refuses
      // "allow" here (the service's 422).
      otherReads: unlistedChoiceSchema.optional(),
      otherWrites: unlistedChoiceSchema.optional(),
      resources: sessionPolicySchema.nullish(),
    }),
  ])
  .refine(
    (v) => v.access !== "custom" || v.allow.length + v.ask.length > 0,
    // The attached ⇔ allow∪ask ≠ ∅ invariant: an all-blocked grant is a detach.
    {
      message:
        "Custom access needs at least one allowed or approval tool. To block everything, detach instead.",
    },
  )
  .refine(
    (v) =>
      v.access !== "custom" || !v.allow.some((tool) => v.ask.includes(tool)),
    { message: "A tool can't be both always-allowed and require approval." },
  );
export type ConnectionGrantRequest = z.infer<typeof connectionGrantSchema>;
/** A grant as the compiler sees it: the `default` request resolved to the
 * provider's concrete shape (`defaultConnectionGrant`). */
export type ConnectionGrantInput = Exclude<
  ConnectionGrantRequest,
  { access: "default" }
>;

/** GET /v1/agents `include` projections — absent = the plain agent list. */
export const agentsIncludeSchema = z.enum(["grants-summary"]).optional();
