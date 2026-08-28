"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { workspaceAccess } from "@/lib/api";
import type { SetWorkspaceAccessInput } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// Workspace-access mutations are headless on the gateway cache: the audited API
// route flushes it server-side (withAudit). Sharing changes affect humans, not
// agent credential traffic, so there is nothing to flush client-side.

export const useWorkspaceAccess = (workspaceId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.workspaceAccess.list(workspaceId),
    queryFn: () => workspaceAccess.list(workspaceId),
    enabled: enabled && workspaceId.length > 0,
  });

export const useSetWorkspaceAccess = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceId,
      users,
      groupIds,
    }: { workspaceId: string } & SetWorkspaceAccessInput) =>
      workspaceAccess.set(workspaceId, { users, groupIds }),
    onSuccess: (_data, { workspaceId }) => {
      qc.invalidateQueries({
        queryKey: queryKeys.workspaceAccess.list(workspaceId),
      });
    },
    onError: (err) =>
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to update workspace access",
      ),
  });
};
