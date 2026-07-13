"use client";

import { useQuery } from "@tanstack/react-query";
import { orgAgents } from "@/lib/api";
import { fetchAllPages } from "@/lib/api/pagination";
import { queryKeys } from "@/lib/api/keys";

const PAGE_LIMIT = 200;

/** Org-wide agents (all pages) — the agent-group member picker's candidates. */
export const useOrgAgents = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.orgAgents.list(),
    queryFn: () =>
      fetchAllPages((cursor) => orgAgents.list({ limit: PAGE_LIMIT, cursor })),
    enabled,
  });
