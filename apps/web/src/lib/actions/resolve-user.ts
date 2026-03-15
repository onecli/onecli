"use server";

import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";

/**
 * Resolves the current authenticated user's internal database ID.
 * Always validates the session server-side — never trusts client input.
 */
export const resolveUserId = async (): Promise<string> => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });

  if (!user) throw new Error("User not found");
  return user.id;
};
