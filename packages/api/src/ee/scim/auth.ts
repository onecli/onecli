import { createHash } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { isEntitled } from "../../lib/entitlements";
import { db } from "@onecli/db";
import { logger } from "../../lib/logger";
import { scimErrorBody } from "./errors";
import { scimJson } from "./respond";

const log = logger.child({ component: "scim-auth" });

/**
 * Bearer auth against OrganizationScimToken (sha-256 of the plaintext; the
 * `oc_scim_` plaintext is shown once at creation and never stored). The 401
 * is SCIM-shaped and hint-free — it never distinguishes missing vs unknown
 * vs revoked tokens (§7.1).
 */

export interface ScimAuthContext {
  organizationId: string;
  tokenId: string;
  label: string;
}

export type ScimEnv = { Variables: { scim: ScimAuthContext } };

export const hashScimToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const unauthorized = (c: Parameters<typeof scimJson>[0]) =>
  scimJson(c, scimErrorBody(401, "Authentication failed."), 401, {
    "WWW-Authenticate": 'Bearer realm="scim"',
  });

export const scimAuth = createMiddleware<ScimEnv>(async (c, next) => {
  // Entitlement recheck on every data-plane request (process-global, no DB):
  // a token minted while licensed must stop working the moment the license
  // is gone. Same hint-free 401 as every other refusal (§7.1).
  if (!isEntitled()) return unauthorized(c);

  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) return unauthorized(c);

  const record = await db.organizationScimToken.findUnique({
    where: { tokenHash: hashScimToken(token) },
    select: { id: true, organizationId: true, label: true, revokedAt: true },
  });
  if (!record || record.revokedAt) return unauthorized(c);

  c.set("scim", {
    organizationId: record.organizationId,
    tokenId: record.id,
    label: record.label,
  });

  // lastUsedAt is a liveness signal for the admin card — fire-and-forget;
  // a failed touch must never fail the provisioning request.
  db.organizationScimToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch((err: unknown) => {
      log.warn({ err, tokenId: record.id }, "scim lastUsedAt update failed");
    });

  await next();
});
