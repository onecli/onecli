"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { counts } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

export const useCounts = () =>
  useQuery({ queryKey: queryKeys.counts.all(), queryFn: counts.get });

/**
 * Whether the workspace has any connection (app account or custom secret) an
 * agent could be given, answered when ASKED rather than from the render that
 * scheduled the question: a create that answers before the counts first load
 * must still offer the new agent's chooser. Cached counts answer at once;
 * otherwise they are fetched.
 */
export const useHasConnectionsToChoose = () => {
  const qc = useQueryClient();
  return useCallback(async () => {
    const data = await qc
      .ensureQueryData({
        queryKey: queryKeys.counts.all(),
        queryFn: counts.get,
      })
      .catch(() => undefined);
    return (data?.apps ?? 0) + (data?.secrets ?? 0) > 0;
  }, [qc]);
};
