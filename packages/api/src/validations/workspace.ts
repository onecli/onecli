import { z } from "zod";
import { sandboxTimezoneSchema } from "./timezone";
import {
  validateDisplayName,
  DISPLAY_NAME_MIN_LEN,
  DISPLAY_NAME_MAX_LEN,
} from "./display-name";

const nameSchema = z
  .string()
  .min(DISPLAY_NAME_MIN_LEN)
  .max(DISPLAY_NAME_MAX_LEN)
  .refine((v) => validateDisplayName(v) === null, {
    message: `Name must be ${DISPLAY_NAME_MIN_LEN}-${DISPLAY_NAME_MAX_LEN} characters with at least one letter or number`,
  });

export const createWorkspaceSchema = z.object({
  name: nameSchema,
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = z
  .object({
    name: nameSchema.optional(),
    // Null restores the platform default; absent leaves it alone. The
    // sandbox tier: this value becomes a container's TZ.
    timezone: sandboxTimezoneSchema.nullable().optional(),
  })
  .refine((data) => data.name !== undefined || data.timezone !== undefined, {
    message: "At least one field must be provided",
  });

export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
