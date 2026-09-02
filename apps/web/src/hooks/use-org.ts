"use client";

import { useQuery } from "@tanstack/react-query";
import { org } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { IS_CLOUD } from "@/lib/env";

/**
 * The current organization (`GET /v1/org`) — today, the create door's source
 * for the org's creation world (`byoLegacy`). An org's world changes only by
 * a manual operator action, hence the infinite stale time.
 *
 * Cloud-only by construction (`enabled: IS_CLOUD`): the door ignores the org
 * on self-host, so the fetch would be pure waste there. NOTE that a disabled
 * query still reports `isPending: true` forever — consumers gating a render
 * on `isPending` must guard it with `IS_CLOUD`.
 *
 * Callers must treat a missing `data` as "not known yet", never as a world
 * decision — gate on `isPending` (in-flight) and let an errored read fall
 * back, so an org-read failure can't lock the page or flip anyone's door.
 */
export const useOrg = () =>
  useQuery({
    queryKey: queryKeys.org.all(),
    queryFn: org.get,
    staleTime: Infinity,
    gcTime: Infinity,
    enabled: IS_CLOUD,
    // A SETTLED error must stay settled for the session: without this, a
    // focus refetch of the errored query can succeed later and swap the
    // page's primary button after paint — the exact transition the door's
    // isPending gate exists to prevent. (Retries still run under the gate:
    // isPending holds until the first success or the FINAL failure.)
    refetchOnWindowFocus: false,
  });
