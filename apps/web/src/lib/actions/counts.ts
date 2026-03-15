"use server";

import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";

async function resolveUserId(authId?: string): Promise<string | null> {
  if (!authId) {
    const session = await getServerSession();
    if (!session) return null;
    authId = session.id;
  }

  const user = await db.user.findUnique({
    where: { externalAuthId: authId },
    select: { id: true },
  });

  return user?.id ?? null;
}

export async function getGatewayCounts(authId?: string) {
  const userId = await resolveUserId(authId);
  if (!userId) return { agents: 0, secrets: 0 };

  const [agents, secrets] = await Promise.all([
    db.agent.count({ where: { userId } }),
    db.secret.count({ where: { userId } }),
  ]);

  return { agents, secrets };
}
