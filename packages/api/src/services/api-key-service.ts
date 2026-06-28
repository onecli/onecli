import { randomBytes } from "crypto";
import { db } from "@onecli/db";
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
