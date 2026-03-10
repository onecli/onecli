"use server";

import { randomBytes } from "crypto";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";

const generateApiKey = () => `oc_${randomBytes(32).toString("hex")}`;

async function resolveUserId(authId?: string): Promise<string> {
  let id = authId;
  if (!id) {
    const session = await getServerSession();
    if (!session) throw new Error("Not authenticated");
    id = session.id;
  }

  const user = await db.user.findUnique({
    where: { externalAuthId: id },
    select: { id: true },
  });

  if (!user) throw new Error("User not found");
  return user.id;
}

export async function getOrCreateApiKey(authId?: string) {
  const userId = await resolveUserId(authId);

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

export async function regenerateApiKey(authId?: string) {
  const userId = await resolveUserId(authId);

  const apiKey = generateApiKey();

  await db.user.update({
    where: { id: userId },
    data: { apiKey },
  });

  return { apiKey };
}
