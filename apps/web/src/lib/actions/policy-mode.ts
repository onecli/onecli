"use server";

import { db } from "@onecli/db";
import { revalidatePath } from "next/cache";
import type { PolicyMode } from "@onecli/api/validations/policy-rule";
import { resolveProjectContext } from "@/lib/actions/resolve-user";
import { invalidateGatewayCacheForOrg } from "@onecli/api/lib/gateway-invalidate";
import { POLICY_EDITING_ENABLED } from "@/lib/env";

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
  // Post-cutover the default posture lives on each scope's Default Rule; the
  // engine never reads `policyMode` again, so this write would be silently
  // dead. The page redirects at editing-on — only a stale tab or a direct
  // invocation reaches here — and it fails loudly instead (the 410 spirit).
  if (POLICY_EDITING_ENABLED) {
    throw new Error(
      "The default policy is now managed on the Policy page's Default Rule.",
    );
  }
  const { organizationId } = await resolveProjectContext();
  await db.organization.update({
    where: { id: organizationId },
    data: { policyMode },
  });
  invalidateGatewayCacheForOrg(organizationId);
  revalidatePath("/", "layout");
};
