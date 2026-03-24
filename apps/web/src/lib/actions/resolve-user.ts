"use server";

import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";

export interface UserContext {
  userId: string;
  accountId: string;
}

/**
 * Resolves the current authenticated user's ID and their active account ID.
 * Always validates the session server-side — never trusts client input.
 */
export const resolveUser = async (): Promise<UserContext> => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: {
      id: true,
      memberships: { select: { accountId: true }, take: 1 },
    },
  });

  if (!user) throw new Error("User not found");
  if (user.memberships.length === 0) throw new Error("No account found");

  return { userId: user.id, accountId: user.memberships[0]!.accountId };
};
