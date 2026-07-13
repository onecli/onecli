"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { orgMembers } from "@/lib/api";
import type { UpdateOrgMemberInput } from "@/lib/api";
import { fetchAllPages } from "@/lib/api/pagination";
import { queryKeys } from "@/lib/api/keys";

const PAGE_LIMIT = 200;

/** Org members via the directory API (all pages) — the group member picker's candidates. */
export const useOrgMembersList = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.orgMembers.list(),
    queryFn: () =>
      fetchAllPages((cursor) => orgMembers.list({ limit: PAGE_LIMIT, cursor })),
    enabled,
  });

/**
 * Member lifecycle + policy-flag mutations (suspend / reinstate / SSO
 * exemption). The members list is server-rendered on the team page, so
 * there is no query cache to invalidate — callers `router.refresh()` in
 * their own onSuccess to re-render the list.
 */
export const useUpdateOrgMember = () =>
  useMutation({
    mutationFn: ({
      userId,
      input,
    }: {
      userId: string;
      input: UpdateOrgMemberInput;
    }) => orgMembers.update(userId, input),
    onError: (err) => toast.error(err.message),
  });
