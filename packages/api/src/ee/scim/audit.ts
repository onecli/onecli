import type { Prisma } from "@onecli/db";
import {
  recordAuditEvent,
  AUDIT_SOURCE,
  type AuditAction,
  type AuditService,
} from "../../services/audit-service";
import { invalidateGatewayCacheForOrg } from "../../lib/gateway-invalidate";
import { resolveScimActor } from "../services/org-directory-service";
import type { ScimAuthContext } from "./auth";

/**
 * Audit for SCIM writes: attributed to the org OWNER (AuditLog.userId is a
 * required FK and SCIM has no acting user — the owner is the org's
 * guaranteed fixed-point identity), `source: "scim"`, with the token
 * id/label riding in metadata. Also flushes the gateway's org cache — SCIM
 * membership/group changes move authorization state.
 */
export const scimAudit = async (
  scim: ScimAuthContext,
  action: AuditAction,
  service: AuditService,
  metadata: Record<string, Prisma.InputJsonValue | null>,
): Promise<void> => {
  const actor = await resolveScimActor(scim.organizationId);
  await recordAuditEvent({
    organizationId: scim.organizationId,
    userId: actor.userId,
    userEmail: actor.userEmail,
    action,
    service,
    source: AUDIT_SOURCE.SCIM,
    metadata: {
      ...metadata,
      scimTokenId: scim.tokenId,
      scimTokenLabel: scim.label,
    },
  });
  invalidateGatewayCacheForOrg(scim.organizationId);
};
