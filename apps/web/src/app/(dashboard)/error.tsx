"use client";

import {
  clearChunkErrorReload,
  useChunkErrorReload,
} from "@/hooks/use-chunk-error-reload";

/**
 * Dashboard error boundary — catches chunk load errors from lazy-loaded
 * dashboard routes after deployments.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useChunkErrorReload(error);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <p className="text-sm font-medium">Something went wrong</p>
      <p className="text-muted-foreground max-w-sm text-center text-xs">
        A new version may have been deployed. Try refreshing the page.
      </p>
      <button
        onClick={() => {
          clearChunkErrorReload();
          reset();
        }}
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
      >
        Try again
      </button>
    </div>
  );
}
