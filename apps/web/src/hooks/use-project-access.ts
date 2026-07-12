"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projectAccess } from "@/lib/api";
import type { SetProjectAccessInput } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// Project-access mutations are headless on the gateway cache: the audited API
// route flushes it server-side (withAudit). Sharing changes affect humans, not
// agent credential traffic, so there is nothing to flush client-side.

export const useProjectAccess = (projectId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.projectAccess.list(projectId),
    queryFn: () => projectAccess.list(projectId),
    enabled: enabled && projectId.length > 0,
  });

export const useSetProjectAccess = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      users,
      groupIds,
    }: { projectId: string } & SetProjectAccessInput) =>
      projectAccess.set(projectId, { users, groupIds }),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({
        queryKey: queryKeys.projectAccess.list(projectId),
      });
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to update project access",
      ),
  });
};
