import { z } from "zod";

/**
 * Replace a workspace's human access bindings. `users` (each with a management
 * `role`) and `groupIds` are the shares to keep; the diff adds, removes, and
 * retargets roles. Since step 13b every binding — the creator's included — is
 * removable; step 13c adds the per-user `owner | member` role (owner may manage
 * the workspace). Groups carry no role in v1.
 */
export const setWorkspaceAccessSchema = z.object({
  users: z
    .array(
      z.object({
        userId: z.string().min(1),
        role: z.enum(["owner", "member"]),
      }),
    )
    .max(1000),
  groupIds: z.array(z.string().min(1)).max(1000),
});

export type SetWorkspaceAccessInput = z.infer<typeof setWorkspaceAccessSchema>;
