import { z } from "zod";

/** Used by POST /api/apps/:provider/config (provider in URL). */
export const configBodySchema = z.object({
  clientId: z.string().min(1, "clientId is required"),
  clientSecret: z.string().min(1, "clientSecret is required"),
});
