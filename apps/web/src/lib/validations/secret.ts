import { z } from "zod";

const injectionConfigSchema = z
  .object({
    headerName: z.string().min(1),
    valueFormat: z.string().optional(),
  })
  .nullable()
  .optional();

export const createSecretSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.enum(["anthropic", "generic"]),
  value: z.string().min(1).max(10000),
  hostPattern: z.string().min(1).max(1000),
  pathPattern: z.string().max(1000).optional(),
  injectionConfig: injectionConfigSchema,
});

export type CreateSecretInput = z.infer<typeof createSecretSchema>;

export const updateSecretSchema = z
  .object({
    value: z.string().min(1).max(10000).optional(),
    hostPattern: z.string().min(1).max(1000).optional(),
    pathPattern: z.string().max(1000).nullable().optional(),
    injectionConfig: injectionConfigSchema,
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateSecretInput = z.infer<typeof updateSecretSchema>;
