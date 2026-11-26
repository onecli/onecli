"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { workspaceLandingAction } from "@/lib/workspaces/actions";
import type { SettingsPageId } from "./pages";
import { withSettingsParam } from "./pages";

/**
 * Switch workspace from inside Settings without leaving it: ask where the
 * workspace lands first, then go straight there with the same Settings page
 * open. One navigation, never through the bare `/w/<id>` (which has no
 * Settings slot, so the modal would close and reopen on the way).
 *
 * The new workspace's URL remounts the modal, which was on screen a moment
 * ago: the switch marks it (`isSettingsCarryOver`), and it reappears in
 * place instead of fading in again.
 */
let carryOverAt = 0;
const CARRY_OVER_MS = 3000;

/** Whether the modal mounting now is a workspace switch's remount. A pure
 *  read (safe in a state initializer, which Strict Mode runs twice); the
 *  modal clears the mark once mounted, so the next open fades in. */
export const isSettingsCarryOver = (): boolean =>
  Date.now() - carryOverAt < CARRY_OVER_MS;

export const clearSettingsCarryOver = () => {
  carryOverAt = 0;
};

export const useSwitchWorkspaceInSettings = (page: SettingsPageId) => {
  const router = useRouter();
  const search = useSearchParams().toString();
  const [pending, startTransition] = useTransition();
  const switchTo = (workspaceId: string) =>
    startTransition(async () => {
      const landing = await workspaceLandingAction(workspaceId);
      carryOverAt = Date.now();
      router.push(withSettingsParam(landing, search, page), { scroll: false });
    });
  return { switchTo, pending };
};
