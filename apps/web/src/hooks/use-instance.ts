"use client";

import { useQuery } from "@tanstack/react-query";
import { instance } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type { InstanceInfo } from "@/lib/api/types";

/**
 * Runtime instance metadata (edition + enterprise entitlement + version +
 * hosted-agents availability).
 *
 * The browser's ONLY correct source for the entitlement: `ENTERPRISE_ENABLED`
 * is runtime env, so the baked client bundle (`CAPS`, `NEXT_PUBLIC_*`) can
 * never know it — a prebuilt self-host image learns it from the API at
 * runtime. Deployment-global and near-immutable per process, hence the
 * infinite stale time.
 *
 * `poll` is for surfaces that must notice `runners.online` flipping (the chat
 * offline banner): a 30s interval on this one shared cache entry. Interval
 * refetches ignore staleTime, so polling and non-polling observers coexist.
 *
 * Returns `null` while loading — callers must treat that as "not locked yet",
 * never as unlicensed, so licensed users are never falsely gated (the same
 * null contract as `usePlanUsage`).
 */
export const useInstance = (
  options: { poll?: boolean } = {},
): InstanceInfo | null => {
  const { data } = useQuery({
    queryKey: queryKeys.instance.all(),
    queryFn: instance.get,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchInterval: options.poll ? 30_000 : undefined,
    refetchIntervalInBackground: false,
  });
  return data ?? null;
};
