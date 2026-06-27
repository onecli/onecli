import { randomBytes } from "crypto";
import { db } from "@onecli/db";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere, scopeCreate, isOrgScope } from "./resource-scope";

export const generateApiKey = (scope?: ResourceScope) => {
  const prefix = scope && isOrgScope(scope) ? "oc_org_" : "oc_";
  return `${prefix}${randomBytes(32).toString("hex")}`;
};

export const getApiKey = async (userId: string, scope: ResourceScope) => {
  const apiKey = await db.apiKey.findFirst({
    where: { userId, ...scopeWhere(scope) },
    select: { key: true },
  });

  // Not having generated a key yet is a normal state, not an error — return
  // null so callers can render an empty / "generate" affordance instead of a
  // 404/500. (Consumers read `result.apiKey ?? ""`.)
  return { apiKey: apiKey?.key ?? null };
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
