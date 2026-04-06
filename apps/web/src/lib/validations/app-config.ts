import { z } from "zod";

export const connectAppSchema = z.object({
  provider: z.string().min(1, "provider is required"),
  clientId: z.string().min(1, "clientId is required"),
  clientSecret: z.string().min(1, "clientSecret is required"),
});
