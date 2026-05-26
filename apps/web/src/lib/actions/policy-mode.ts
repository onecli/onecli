"use server";

import { db } from "@onecli/db";
import { revalidatePath } from "next/cache";
import type { PolicyMode } from "@onecli/api/validations/policy-rule";
import { resolveProjectContext } from "@/lib/actions/resolve-user";
import { invalidateGatewayCacheForOrg } from "@onecli/api/lib/gateway-invalidate";

export const getPolicyMode = async (): Promise<PolicyMode> => {
  const { organizationId } = await resolveProjectContext();
  const org = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { policyMode: true },
  });
  return org.policyMode as PolicyMode;
};

export const updatePolicyMode = async (
  policyMode: PolicyMode,
): Promise<void> => {
  const { organizationId } = await resolveProjectContext();
  await db.organization.update({
    where: { id: organizationId },
    data: { policyMode },
  });
  invalidateGatewayCacheForOrg(organizationId);
  revalidatePath("/", "layout");
};
