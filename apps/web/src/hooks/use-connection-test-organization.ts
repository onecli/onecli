"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";
import { getActiveOrganizationId } from "@/lib/workspaces/actions";
import { getOrganizationId, getWorkspaceId } from "@/lib/api-fetch";

/** Resolve the org from the server-validated /w or /org request context.
 * Unlike the cloud-only org-info query, this also runs for self-hosters. */
export const useConnectionTestOrganization = () =>
  useQuery({
    queryKey: queryKeys.org.connectionTestOrganization(),
    queryFn: getActiveOrganizationId,
    enabled: Boolean(getWorkspaceId() || getOrganizationId()),
    staleTime: 5 * 60_000,
  });
