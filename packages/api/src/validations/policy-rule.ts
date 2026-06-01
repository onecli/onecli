import { z } from "zod";

export const policyModeSchema = z.enum(["allow", "deny"]);
export type PolicyMode = z.infer<typeof policyModeSchema>;

export const ruleConditionSchema = z.object({
  target: z.enum(["body"]),
  operator: z.enum(["contains"]),
  value: z.string().min(1).max(1000),
  key: z.string().max(500).optional(),
});

export type RuleCondition = z.infer<typeof ruleConditionSchema>;

export const createPolicyRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    hostPattern: z.string().min(1).max(1000),
    pathPattern: z.string().max(1000).optional(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
    action: z.enum(["block", "rate_limit", "manual_approval", "allow"]),
    enabled: z.boolean(),
    agentId: z.string().optional(),
    rateLimit: z.number().int().min(1).max(1_000_000).optional(),
    rateLimitWindow: z.enum(["minute", "hour", "day"]).optional(),
    conditions: z.array(ruleConditionSchema).max(10).optional(),
  })
  .refine(
    (data) => {
      if (data.action === "rate_limit") {
        return (
          data.rateLimit !== undefined && data.rateLimitWindow !== undefined
        );
      }
      return true;
    },
    {
      message:
        "rateLimit and rateLimitWindow are required when action is rate_limit",
    },
  );

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
    action: z
      .enum(["block", "rate_limit", "manual_approval", "allow"])
      .optional(),
    enabled: z.boolean().optional(),
    agentId: z.string().nullable().optional(),
    rateLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
    rateLimitWindow: z.enum(["minute", "hour", "day"]).nullable().optional(),
    conditions: z.array(ruleConditionSchema).max(10).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdatePolicyRuleInput = z.infer<typeof updatePolicyRuleSchema>;
