import { randomBytes } from "node:crypto";
import { db } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import { hashScimToken } from "../scim/auth";

/**
 * Bearer tokens for the org's /scim/v2 endpoint. The plaintext
 * (`oc_scim_` + 48 hex) exists only in the create response — the DB stores
 * its sha-256. The `oc_` prefix is deliberate: a SCIM token mispasted into a
 * /v1 client dies safely in strictApiKeyAuth instead of falling through to
 * session auth. Revocation is soft (revokedAt) so the row keeps anchoring
 * its audit history.
 */

export interface ScimTokenRow {
  id: string;
  label: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

const tokenSelect = {
  id: true,
  label: true,
  lastUsedAt: true,
  createdAt: true,
} as const;

export const listScimTokens = (
  organizationId: string,
): Promise<ScimTokenRow[]> =>
  db.organizationScimToken.findMany({
    where: { organizationId, revokedAt: null },
    select: tokenSelect,
    orderBy: { createdAt: "asc" },
  });

export const createScimToken = async (
  organizationId: string,
  label: string,
  createdByUserId: string,
): Promise<ScimTokenRow & { token: string }> => {
  const token = `oc_scim_${randomBytes(24).toString("hex")}`;
  const row = await db.organizationScimToken.create({
    data: {
      organizationId,
      tokenHash: hashScimToken(token),
      label,
      createdByUserId,
    },
    select: tokenSelect,
  });
  return { ...row, token };
};

/** Idempotent soft revoke — an already-revoked token is a success. */
export const revokeScimToken = async (
  organizationId: string,
  tokenId: string,
): Promise<void> => {
  const existing = await db.organizationScimToken.findFirst({
    where: { id: tokenId, organizationId },
    select: { revokedAt: true },
  });
  if (!existing) {
    throw new ServiceError("NOT_FOUND", "SCIM token not found");
  }
  if (existing.revokedAt) return;
  await db.organizationScimToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date() },
  });
};
