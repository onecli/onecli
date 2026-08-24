"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { workspaces } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/** The caller's visible workspaces. Org comes from the URL scope by default; the
 * explicit organizationId override serves the account-route Get Started picker
 * (org from the default-org cookie, validated server-side). */
export const useWorkspacesList = (
  options: { organizationId?: string; enabled?: boolean } = {},
) =>
  useQuery({
    queryKey: queryKeys.workspaces.list(options.organizationId),
    queryFn: () => workspaces.list({ organizationId: options.organizationId }),
    enabled: options.enabled ?? true,
  });

// Workspace rename/delete go through the audited `/v1/workspaces/:id` routes. Delete
// flushes the gateway cache for the removed keys server-side, so there is
// nothing to flush client-side. The workspaces list is server-rendered, so
// callers handle the on-success refresh/redirect themselves rather than
// invalidating a query cache.

export const useRenameWorkspace = () =>
  useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      workspaces.rename(id, name),
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to rename workspace",
      ),
  });

export const useDeleteWorkspace = () =>
  useMutation({
    mutationFn: (id: string) => workspaces.remove(id),
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to delete workspace",
      ),
  });
