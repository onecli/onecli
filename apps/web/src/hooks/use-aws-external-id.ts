"use client";

import { useQuery } from "@tanstack/react-query";
import { awsExternalId } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/**
 * The organization's AWS `sts:ExternalId`, for the AWS Role connect screen.
 *
 * The scope is passed in rather than inferred: this runs in the connect popup,
 * whose pathname carries no `/w/<id>` or `/org/<id>` for `apiFetch` to read —
 * the ids live in the query string (see `lib/api/aws-external-id.ts`).
 *
 * Stable for the life of the org once minted, so it is cached indefinitely —
 * the popup is short-lived and there is nothing to re-fetch. Retries ride the
 * app-wide default: the panel has a real failure state, so a slow error beats
 * a spinner that never resolves.
 */
export const useAwsExternalId = (scope?: {
  workspaceId?: string;
  orgId?: string;
}) =>
  useQuery({
    queryKey: queryKeys.awsExternalId.all(scope),
    queryFn: async () => (await awsExternalId.get(scope)).externalId,
    staleTime: Infinity,
  });
