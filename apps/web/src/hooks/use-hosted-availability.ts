"use client";

import { useInstance } from "@/hooks/use-instance";
import {
  homeDurabilityMessage,
  hostedAvailability,
  type HostedAvailability,
} from "@/lib/agents/availability";

/**
 * The hosted-agents availability state — `useInstance()`'s shared cache entry
 * run through the one §3.13 translation point. `poll` (the chat surfaces)
 * keeps the offline banner honest within ~30s of the agents recovering.
 */
export const useHostedAvailability = (
  options: { poll?: boolean } = {},
): HostedAvailability => hostedAvailability(useInstance(options));

/**
 * The one sentence about where agent files live (§3.9), off the same shared
 * cache entry — null when the platform makes no claim. Lives beside
 * availability so both runner→agent translations stay in one place.
 */
export const useHomeDurabilityMessage = (): string | null =>
  homeDurabilityMessage(useInstance());
