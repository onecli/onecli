import { ComposerSkeleton } from "./composer-skeleton";
import { ThreadSkeleton } from "./thread-skeleton";

/**
 * The whole Chat section while it loads: the thread and the composer's
 * strip, in the full-height column the chat itself fills.
 */
export const ChatSkeleton = () => (
  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <ThreadSkeleton />
    <ComposerSkeleton />
  </div>
);
