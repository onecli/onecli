"use client";

import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { notifyIfStaleBuild } from "@/lib/stale-build";

export const QueryProvider = ({ children }: { children: ReactNode }) => {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Any read or write that fails because this tab predates a deploy (a
        // server action the new build doesn't know) tells the person to
        // reload: retrying from the old build can never succeed.
        queryCache: new QueryCache({ onError: notifyIfStaleBuild }),
        mutationCache: new MutationCache({ onError: notifyIfStaleBuild }),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};
