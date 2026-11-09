"use client";

import { useInstance } from "@/hooks/use-instance";
import {
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
