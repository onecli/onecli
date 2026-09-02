import { z } from "zod";

// Shape-only guard — the service's normalizeDomain (lowercase, punycode,
// exact-domain pattern) is the authoritative validation.
export const createOrgDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(3, "Enter a valid domain like example.com")
    .max(253, "Domain is too long"),
});
