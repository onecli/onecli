"use server";

import { getPlanUsage } from "@/ee/billing/api-request-actions";

export interface ResourceQuota {
  current: number;
  limit: number;
  plan: string;
  atLimit: boolean;
  organizationId: string;
}

export const getResourceQuota = async (
  resourceName: string,
): Promise<ResourceQuota> => {
  const usage = await getPlanUsage();
  const resource = usage.resources.find((r) => r.name === resourceName);
  return {
    current: resource?.current ?? 0,
    limit: resource?.limit ?? Infinity,
    plan: usage.plan,
    atLimit: resource
      ? resource.limit !== Infinity && resource.current >= resource.limit
      : false,
    organizationId: usage.organizationId,
  };
};
