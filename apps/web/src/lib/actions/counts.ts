"use server";

import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { getGatewayCounts as getGatewayCountsService } from "@/lib/services/counts-service";

export const getGatewayCounts = async () => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });

  if (!user) throw new Error("User not found");

  return getGatewayCountsService(user.id);
};
