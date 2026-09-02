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

  // `kind: "user"` — this helper owns PERSONAL keys only. Without the filter,
  // a platform-minted service key (e.g. a channel presence's approvals key)
  // in the same (user, scope) would make this findFirst nondeterministic, and
  // "regenerate my key" could rotate the service key out from under the
  // machinery holding it — or worse, hand the personal flow a service key.
  const existing = await db.apiKey.findFirst({
    where: { userId, kind: "user", ...scopeWhere(scope) },
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
 * The dashboard read paths use it so an admin/owner viewing a workspace they did
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
  // Personal keys only — same reasoning as `regenerateApiKey` above.
  const existing = await db.apiKey.findFirst({
    where: { userId, kind: "user", ...scopeWhere(scope) },
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
 * Mint a SERVICE key: a platform-created machine credential (`kind:
 * "service"`), distinct from a person's own key so the personal flows above
 * never see it. The key still belongs to a real user — the gateway
 * re-validates the owner's live workspace access on every use and stamps
 * `approved_by` from it — so `userId` is the human whose authority the
 * machine borrows (e.g. the member who attached a channel presence).
 *
 * Callers own the row's lifecycle: store the returned id and revoke on
 * teardown (`revokeServiceApiKey`).
 */
export const createServiceApiKey = async (
  userId: string,
  scope: ResourceScope,
  name: string,
): Promise<{ id: string; apiKey: string }> => {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true },
  });
  const key = generateApiKey(scope);
  const created = await db.apiKey.create({
    data: {
      key,
      userId,
      userEmail: user.email,
      name,
      kind: "service",
      ...scopeCreate(scope),
    },
    select: { id: true },
  });
  return { id: created.id, apiKey: key };
};

/**
 * Delete a service key by id. Deliberately fenced to `kind: "service"` so no
 * teardown path can ever delete a person's own key by mistake; deleting an
 * already-gone key is a no-op (teardown must be idempotent).
 */
export const revokeServiceApiKey = async (id: string): Promise<void> => {
  await db.apiKey.deleteMany({ where: { id, kind: "service" } });
};
