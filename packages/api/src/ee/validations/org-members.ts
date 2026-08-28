import { z } from "zod";
import { directoryListQuerySchema } from "./directory";

/**
 * Exactly one member mutation per request: a lifecycle change (suspend /
 * reinstate) or the break-glass SSO exemption flip — never both, so each
 * audit event describes a single change.
 */
export const updateOrgMemberSchema = z.union([
  z.strictObject({ status: z.enum(["active", "suspended"]) }),
  z.strictObject({ ssoExempt: z.boolean() }),
]);

export const listOrgMembersQuerySchema = directoryListQuerySchema.extend({
  status: z.enum(["active", "suspended"]).optional(),
});

/**
 * First-party provisioning (the org-key twin of SCIM POST /Users): the
 * member is identified by email; a display name is optional.
 */
export const createOrgMemberSchema = z.strictObject({
  email: z
    .string({ message: "Email is required" })
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .max(254, "Enter a valid email address"),
  name: z.string().trim().min(1).max(200).optional(),
});
