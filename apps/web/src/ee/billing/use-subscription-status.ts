"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";
import { getSubscriptionStatus } from "./actions";

/**
 * Current org subscription status, fetched via React Query so it is deduped and
 * cached across components (instead of a per-component `useEffect`). Returns
 * `null` while the first request is in flight.
 */
export const useSubscriptionStatus = () => {
  const { data } = useQuery({
    queryKey: queryKeys.billing.subscriptionStatus(),
    queryFn: () => getSubscriptionStatus(),
    staleTime: 60_000,
  });

  return data ?? null;
};
