"use server";

import { resolveUser } from "@/lib/actions/resolve-user";
import { getGatewayCounts as getGatewayCountsService } from "@/lib/services/counts-service";

export const getGatewayCounts = async () => {
  const { projectId } = await resolveUser();
  return getGatewayCountsService(projectId);
};
