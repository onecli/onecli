import { z } from "zod";

export const createPolicyRuleSchema = z.object({
  name: z.string().trim().min(1).max(255),
  hostPattern: z.string().min(1).max(1000),
  pathPattern: z.string().max(1000).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  action: z.enum(["block"]),
  enabled: z.boolean(),
  agentId: z.string().optional(),
});

export type CreatePolicyRuleInput = z.infer<typeof createPolicyRuleSchema>;

export const updatePolicyRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    hostPattern: z.string().min(1).max(1000).optional(),
    pathPattern: z.string().max(1000).nullable().optional(),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
      .nullable()
      .optional(),
    action: z.enum(["block"]).optional(),
    enabled: z.boolean().optional(),
    agentId: z.string().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdatePolicyRuleInput = z.infer<typeof updatePolicyRuleSchema>;
