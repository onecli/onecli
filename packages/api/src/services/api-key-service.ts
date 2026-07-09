import { randomBytes } from "crypto";
import { readFileSync } from "node:fs";
import { db } from "@onecli/db";
import { logger } from "../lib/logger";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere, scopeCreate, isOrgScope } from "./resource-scope";

export const generateApiKey = (scope?: ResourceScope) => {
  const prefix = scope && isOrgScope(scope) ? "oc_org_" : "oc_";
  return `${prefix}${randomBytes(32).toString("hex")}`;
};

export const regenerateApiKey = async (
  userId: string,
  scope: ResourceScope,
) => {
  const key = generateApiKey(scope);

  const existing = await db.apiKey.findFirst({
    where: { userId, ...scopeWhere(scope) },
    select: { id: true },
  });

  if (existing) {
    await db.apiKey.update({
      where: { id: existing.id },
      data: { key },
    });
  } else {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    await db.apiKey.create({
      data: { key, userId, userEmail: user.email, ...scopeCreate(scope) },
    });
  }

  return { apiKey: key };
};

/**
 * Return the user's API key for `scope`, creating one if none exists yet.
 * Idempotent — a single call both reads and (lazily) provisions a key for any
 * user authorized for the scope.
 *
 * The dashboard read paths use it so an admin/owner viewing a project they did
 * not create still gets *their own* key instead of an empty "no key yet" state —
 * keys are personal (they carry the user's identity for audit/attribution), so
 * we never surface another user's.
 *
 * `created` is `true` only when a key was actually minted, letting callers audit
 * the first provision without logging on every read.
 */
export const ensureApiKey = async (
  userId: string,
  scope: ResourceScope,
): Promise<{ apiKey: string; created: boolean }> => {
  const existing = await db.apiKey.findFirst({
    where: { userId, ...scopeWhere(scope) },
    select: { key: true },
  });
  if (existing) return { apiKey: existing.key, created: false };

  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true },
  });
  const key = generateApiKey(scope);
  await db.apiKey.create({
    data: { key, userId, userEmail: user.email, ...scopeCreate(scope) },
  });
  return { apiKey: key, created: true };
};

/**
 * Canonical org API key shape: `oc_org_` + 32 random bytes hex (lowercase),
 * matching `generateApiKey({ organizationId })`. Used to validate an
 * operator-supplied bootstrap key.
 */
export const ORG_API_KEY_REGEX = /^oc_org_[0-9a-f]{64}$/;

export const isValidOrgApiKey = (value: string): boolean =>
  ORG_API_KEY_REGEX.test(value);

/**
 * An operator-supplied bootstrap org API key, if configured — from
 * `ONECLI_ORG_API_KEY`, or the file at `ONECLI_ORG_API_KEY_FILE` (the Docker/K8s
 * secrets `_FILE` convention). Env wins over the file; returns `undefined` when
 * neither is set.
 */
export const resolveConfiguredOrgApiKey = (): string | undefined => {
  const direct = process.env.ONECLI_ORG_API_KEY?.trim();
  if (direct) return direct;
  const file = process.env.ONECLI_ORG_API_KEY_FILE?.trim();
  if (file) {
    let fromFile: string;
    try {
      fromFile = readFileSync(file, "utf8").trim();
    } catch (err) {
      throw new Error(
        `ONECLI_ORG_API_KEY_FILE could not be read (${file}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (fromFile) return fromFile;
  }
  return undefined;
};

/**
 * Ensure the shared organization has its single bootstrap org-scoped API key,
 * creating it once (idempotent). Lets an operator obtain an org key on onprem —
 * including the connect-only slim edition, which has no settings UI.
 *
 * - If the org already has an org-scoped key, return it unchanged (never rotate).
 * - Else use the operator-supplied key (`ONECLI_ORG_API_KEY` / `_FILE`) when set
 *   — validated against {@link ORG_API_KEY_REGEX}, throwing on a malformed value
 *   (fail loud; we never silently substitute a generated key for the one the
 *   operator expects) — otherwise generate one.
 * - A generated value is logged once so it can be retrieved; a supplied value is
 *   never logged.
 *
 * The key is attributed to `userId` (the first user to create the shared org).
 */
export const ensureBootstrapOrgApiKey = async ({
  organizationId,
  userId,
  userEmail,
}: {
  organizationId: string;
  userId: string;
  userEmail: string;
}): Promise<{
  apiKey: string;
  created: boolean;
  source: "existing" | "env" | "generated";
}> => {
  const existing = await db.apiKey.findFirst({
    where: { organizationId, scope: "organization" },
    select: { key: true },
  });
  if (existing) {
    return { apiKey: existing.key, created: false, source: "existing" };
  }

  const configured = resolveConfiguredOrgApiKey();
  if (configured !== undefined && !isValidOrgApiKey(configured)) {
    throw new Error(
      "ONECLI_ORG_API_KEY is malformed — expected an 'oc_org_' prefix followed " +
        "by 64 lowercase hex chars (generate one with: oc_org_$(openssl rand -hex 32)).",
    );
  }
  const source: "env" | "generated" = configured ? "env" : "generated";
  const key = configured ?? generateApiKey({ organizationId });

  try {
    await db.apiKey.create({
      data: { key, userId, userEmail, ...scopeCreate({ organizationId }) },
    });
  } catch (err) {
    // Concurrent first-join race (the unique `key` loses if two joins seed the
    // same supplied value): re-read and use whatever landed.
    const raced = await db.apiKey.findFirst({
      where: { organizationId, scope: "organization" },
      select: { key: true },
    });
    if (raced) return { apiKey: raced.key, created: false, source: "existing" };
    throw err;
  }

  if (source === "generated") {
    logger.warn(
      `Generated bootstrap org API key: ${key}\n` +
        "  Save it now — shown only once. Set ONECLI_ORG_API_KEY to pin a known " +
        "value, and rotate it if your container logs are shipped.",
    );
  } else {
    logger.info("Seeded bootstrap org API key from ONECLI_ORG_API_KEY.");
  }

  return { apiKey: key, created: true, source };
};
