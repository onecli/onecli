"use server";

import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import {
  getUser,
  updateProfile as updateProfileService,
} from "@/lib/services/user-service";

export const getCurrentUser = async () => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });

  if (!user) return null;

  return getUser(user.id);
};

export const updateProfile = async (data: { name: string }) => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });

  if (!user) throw new Error("User not found");

  return updateProfileService(user.id, data.name);
};
