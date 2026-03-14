"use server";

import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";

export async function ensureUser() {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  const user = await db.user.upsert({
    where: { externalAuthId: session.id },
    create: {
      externalAuthId: session.id,
      email: session.email ?? "",
      name: session.name,
    },
    update: {
      email: session.email ?? "",
      name: session.name,
    },
    select: { id: true },
  });

  return { id: user.id };
}
