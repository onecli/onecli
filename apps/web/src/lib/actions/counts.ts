"use server";

import { resolveUser } from "@/lib/actions/resolve-user";
import { getGatewayCounts as getGatewayCountsService } from "@/lib/services/counts-service";

export const getGatewayCounts = async () => {
  const { accountId } = await resolveUser();
  return getGatewayCountsService(accountId);
};
