"use client";

import { useState } from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
  type UseInfiniteQueryOptions,
} from "@tanstack/react-query";

/** How often a Live list refreshes. */
export const LIVE_POLL_MS = 3_000;

/**
 * Activity's list behavior, shared by Network and Runs so the two tabs cannot
 * drift: newest first, keyset "Load more", and a Live switch. The caller
 * supplies the list's `infiniteQueryOptions`; this adds the Live behavior.
 *
 * While Live, the list holds ONE page and refreshes it every
 * {@link LIVE_POLL_MS}. Loading an older page pauses Live, because a refetch
 * of an infinite query re-reads every loaded page in turn. Turning Live back
 * on trims the list to its first page before polling resumes.
 */
export const useLiveList = <TPage, TKey extends QueryKey, TCursor>(
  options: UseInfiniteQueryOptions<
    TPage,
    Error,
    InfiniteData<TPage>,
    TKey,
    TCursor
  >,
) => {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(true);
  const query = useInfiniteQuery({
    ...options,
    refetchInterval: live ? LIVE_POLL_MS : false,
  });

  const setLiveMode = (next: boolean) => {
    if (next) {
      queryClient.setQueryData<InfiniteData<TPage>>(
        options.queryKey,
        (data) =>
          data && {
            pages: data.pages.slice(0, 1),
            pageParams: data.pageParams.slice(0, 1),
          },
      );
    }
    setLive(next);
  };

  const loadMore = () => {
    setLive(false);
    void query.fetchNextPage();
  };

  return {
    pages: query.data?.pages ?? [],
    isPending: query.isPending,
    // Only a failed FIRST load is an error state. A failed Live poll keeps
    // the last good page on screen and retries on the next tick.
    isError: query.isLoadingError,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore,
    live,
    setLive: setLiveMode,
  };
};
