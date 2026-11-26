"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { saveCredentials } from "@/lib/api/connect-credentials";
import { queryKeys } from "@/lib/api/keys";

/** The audited save route owns gateway invalidation. Refresh UI data without
 * making an offline metadata request hold credential correction hostage. */
export const useSaveCredentials = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: saveCredentials,
    retry: false,
    gcTime: 0,
    onSuccess: () => {
      void client
        .invalidateQueries({ queryKey: queryKeys.connections.root() })
        .catch(() => {});
      void client
        .invalidateQueries({ queryKey: queryKeys.counts.all() })
        .catch(() => {});
    },
  });
};
