import { z } from "zod";

// Group→role mappings (step 15). Owner is never IdP-managed, so the only
// assignable roles are admin | member.
const mappableRole = z.enum(["admin", "member"]);

// Bounded well inside Postgres int4 so an out-of-range value is a clean 400,
// not a DB overflow 500. Priorities are assigned in a small range anyway
// (reorder positions, or the lowest-1 on create).
const priority = z.number().int().min(-1_000_000).max(1_000_000);

export const createRoleMappingSchema = z.object({
  groupId: z.string().min(1),
  role: mappableRole,
  // Optional: the service appends new mappings at the lowest priority when omitted.
  priority: priority.optional(),
});

export const updateRoleMappingSchema = z.object({
  role: mappableRole,
  priority: priority.optional(),
});

export const reorderRoleMappingsSchema = z.object({
  // Highest priority first (index 0 wins). Must list every mapping exactly once.
  orderedIds: z.array(z.string().min(1)).min(1),
});

// Priority is resolved server-side in the preview (existing mapping's priority,
// or the lowest slot for a new one), so the client doesn't send it.
export const previewRoleMappingSchema = z.object({
  groupId: z.string().min(1),
  role: mappableRole,
});
