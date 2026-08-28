"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  availabilityConfigKey,
  getConfig,
  setConfig,
  type AppAvailabilityConfig,
} from "@/ee/app-availability/api";
import { queryKeys } from "@/lib/api/keys";

// App-availability management hooks (EE org admin page). The write goes through
// the audited API route, which flushes the gateway connect cache org-wide
// server-side (withAudit) — so the mutation is headless beyond the query cache.

export const useAppAvailability = (enabled = true) =>
  useQuery({
    queryKey: availabilityConfigKey(),
    queryFn: getConfig,
    retry: false,
    enabled,
  });

export const useSetAppAvailability = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AppAvailabilityConfig) => setConfig(input),
    onSuccess: (data) => {
      qc.setQueryData(availabilityConfigKey(), data);
      // Refresh the connect-picker's available set for this scope too.
      qc.invalidateQueries({ queryKey: queryKeys.appAvailability.all() });
      toast.success("App availability updated.");
    },
    onError: (err) =>
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to update app availability.",
      ),
  });
};
