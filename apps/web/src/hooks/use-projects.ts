"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { projects } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/** The caller's visible projects. Org comes from the URL scope by default; the
 * explicit organizationId override serves the account-route Get Started picker
 * (org from the default-org cookie, validated server-side). */
export const useProjectsList = (
  options: { organizationId?: string; enabled?: boolean } = {},
) =>
  useQuery({
    queryKey: queryKeys.projects.list(options.organizationId),
    queryFn: () => projects.list({ organizationId: options.organizationId }),
    enabled: options.enabled ?? true,
  });

// Project rename/delete go through the audited `/v1/projects/:id` routes. Delete
// flushes the gateway cache for the removed keys server-side, so there is
// nothing to flush client-side. The projects list is server-rendered, so
// callers handle the on-success refresh/redirect themselves (as the old actions
// did) rather than invalidating a query cache.

export const useRenameProject = () =>
  useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      projects.rename(id, name),
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to rename project",
      ),
  });

export const useDeleteProject = () =>
  useMutation({
    mutationFn: (id: string) => projects.remove(id),
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to delete project",
      ),
  });
