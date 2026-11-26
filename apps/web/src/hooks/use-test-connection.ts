"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { testConnection } from "@/lib/api/connection-test";
import { queryKeys } from "@/lib/api/keys";

export const useTestConnection = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: testConnection,
    retry: false,
    // Successful checks update role metadata. Refresh after either outcome,
    // including a timeout after the gateway wrote its result. The popup has
    // no URL scope, so sweep the namespace rather than its default key.
    onSettled: () => {
      // The check's deadline must release Continue even if an unrelated API
      // metadata refetch is offline. Refresh in the background.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.connections.root(),
      });
    },
  });
};
