"use server";

import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";

export async function getCurrentUser() {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
    },
  });

  return user;
}

export async function updateProfile(data: { name: string }) {
  const name = data.name.trim();

  if (name.length === 0 || name.length > 255) {
    throw new Error("Name must be between 1 and 255 characters");
  }

  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  const user = await db.user.update({
    where: { externalAuthId: session.id },
    data: { name },
    select: {
      id: true,
      email: true,
      name: true,
    },
  });

  return user;
}
