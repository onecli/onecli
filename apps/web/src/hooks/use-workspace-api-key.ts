"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { user } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/** The caller's personal API key for the URL's workspace, minted on first
 * read (`GET /v1/user/api-key`). */
export const useWorkspaceApiKey = () =>
  useQuery({
    queryKey: queryKeys.workspaceApiKey.all(),
    queryFn: user.apiKey,
  });

export const useRegenerateWorkspaceApiKey = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: user.regenerateApiKey,
    onSuccess: (result) => {
      qc.setQueryData(queryKeys.workspaceApiKey.all(), result);
      // Install's commands embed this key: refresh them so a copy there
      // never hands out the revoked one.
      qc.invalidateQueries({ queryKey: queryKeys.installInfo.all() });
      toast.success("API key regenerated");
    },
    onError: () => toast.error("Failed to regenerate API key"),
  });
};
