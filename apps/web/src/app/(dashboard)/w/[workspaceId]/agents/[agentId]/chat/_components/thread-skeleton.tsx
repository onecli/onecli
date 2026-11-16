import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import { TRANSCRIPT_PADDING } from "./transcript-layout";

/**
 * The conversation while it loads: two exchanges on the transcript's own
 * column (`max-w-3xl`, `px-4`, the same padding), a sent bubble on the
 * right and the answer's lines on the left, so the real thread lands where
 * the skeleton stood. No fade-in: the route, the agent frame and the chat
 * each mount their own copy as the page resolves, and a fade would blink
 * at every hand-off.
 */
export const ThreadSkeleton = () => (
  <div aria-busy="true" className="min-h-0 flex-1 overflow-hidden">
    <span className="sr-only">Loading the conversation</span>
    <div
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-col gap-6 px-4",
        TRANSCRIPT_PADDING,
      )}
    >
      <Skeleton className="h-10 w-1/2 self-end rounded-xl" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Skeleton className="h-10 w-1/3 self-end rounded-xl" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  </div>
);
