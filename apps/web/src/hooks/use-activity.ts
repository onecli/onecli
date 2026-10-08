"use client";

import { infiniteQueryOptions } from "@tanstack/react-query";
import type { ActivityPageParams } from "@onecli/api/validations/request-logs";
import { getActivityPage } from "@/lib/actions/request-logs";
import { queryKeys } from "@/lib/api/keys";
import { useLiveList } from "./use-live-list";

type ActivityCursor = NonNullable<ActivityPageParams["cursor"]>;

/**
 * The gateway request log (Activity's Network tab), newest first, as a Live
 * list. The page read is a server action (`getActivityPage`): the request
 * log has no `/v1` endpoint, and the action parses its params like a route.
 */
export const useActivityList = (
  params: Omit<ActivityPageParams, "cursor" | "limit">,
) =>
  useLiveList(
    infiniteQueryOptions({
      queryKey: queryKeys.activity.list(params),
      queryFn: ({ pageParam }) =>
        getActivityPage({ ...params, ...(pageParam && { cursor: pageParam }) }),
      initialPageParam: undefined as ActivityCursor | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
