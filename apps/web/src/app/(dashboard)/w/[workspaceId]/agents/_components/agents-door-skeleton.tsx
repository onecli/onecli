import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";

/**
 * The agents page while it decides where to go: the shape of its one real
 * state (the centered create card), never a list of agent cards. Shared by
 * the route's `loading.tsx` and the page while it reads the list or
 * forwards to the first agent, so the two never flash different layouts.
 */
export const AgentsDoorSkeleton = () => (
  <Card className="flex flex-col items-center justify-center gap-4 py-16">
    <Skeleton className="size-12 rounded-full" />
    <div className="flex flex-col items-center gap-2">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-3 w-56" />
    </div>
    <Skeleton className="h-8 w-28 rounded-md" />
  </Card>
);
