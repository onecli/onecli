import { z } from "zod";
import { directoryListQuerySchema } from "./directory";

export const groupNameSchema = z
  .string()
  .trim()
  .min(1, "Group name is required")
  .max(100, "Group name is too long");

export const createGroupSchema = z.object({ name: groupNameSchema });

export const updateGroupSchema = z.strictObject({ name: groupNameSchema });

/** Bulk replace-set for the UI dialog; incremental ops carry ids in the path. */
export const setGroupMembersSchema = z.object({
  userIds: z.array(z.string().min(1)).max(1000),
});

export const listGroupsQuerySchema = directoryListQuerySchema.extend({
  source: z.enum(["manual", "scim"]).optional(),
});
