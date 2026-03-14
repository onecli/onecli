"use server";

import { randomBytes } from "crypto";
import { db } from "@onecli/db";
import { resolveUserId } from "@/lib/actions/resolve-user";

const generateApiKey = () => `oc_${randomBytes(32).toString("hex")}`;

export async function getOrCreateApiKey() {
  const userId = await resolveUserId();

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { apiKey: true },
  });

  if (user?.apiKey) {
    return { apiKey: user.apiKey };
  }

  const apiKey = generateApiKey();

  await db.user.update({
    where: { id: userId },
    data: { apiKey },
  });

  return { apiKey };
}

export async function regenerateApiKey() {
  const userId = await resolveUserId();

  const apiKey = generateApiKey();

  await db.user.update({
    where: { id: userId },
    data: { apiKey },
  });

  return { apiKey };
}
