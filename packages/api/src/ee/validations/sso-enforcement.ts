import { z } from "zod";

export const updateSsoEnforcementSchema = z.object({
  ssoRequired: z.boolean(),
});
