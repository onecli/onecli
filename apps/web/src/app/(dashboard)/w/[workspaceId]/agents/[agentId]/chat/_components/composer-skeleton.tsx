import { Skeleton } from "@onecli/ui/components/skeleton";

/**
 * The composer's footprint while the chat loads: the same `border-t p-3`
 * strip and `max-w-3xl` row as the real one (the attach button, the 36px
 * box, the send button), so the composer arrives without the thread above
 * it jumping by its height.
 */
export const ComposerSkeleton = () => (
  <div
    aria-hidden
    data-testid="composer-skeleton"
    className="shrink-0 border-t p-3"
  >
    <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
      <Skeleton className="size-9 shrink-0" />
      <Skeleton className="h-9 min-w-0 flex-1" />
      <Skeleton className="size-9 shrink-0" />
    </div>
  </div>
);
