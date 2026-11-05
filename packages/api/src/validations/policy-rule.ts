import { z } from "zod";

export const ruleConditionSchema = z.object({
  target: z.enum(["body"]),
  operator: z.enum(["contains"]),
  value: z.string().min(1).max(1000),
  key: z.string().max(500).optional(),
});

export type RuleCondition = z.infer<typeof ruleConditionSchema>;
