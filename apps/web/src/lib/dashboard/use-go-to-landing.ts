"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import { orgLanding, workspaceLanding } from "./landing";

/**
 * Go to a workspace or an org in one navigation: look up where it lands
 * (its first agent) and go straight there. A transition, so the page on
 * screen stays put until the next one is ready.
 */
export const useGoToLanding = () => {
  const router = useRouter();
  const go = (landing: Promise<string>) =>
    startTransition(async () => {
      router.push(await landing);
    });
  return {
    goToWorkspace: (workspaceId: string) => go(workspaceLanding(workspaceId)),
    goToOrg: (orgId: string) => go(orgLanding(orgId)),
  };
};
