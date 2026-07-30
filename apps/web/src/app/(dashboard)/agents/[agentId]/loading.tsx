import { Skeleton } from "@onecli/ui/components/skeleton";

export default function AgentDetailLoading() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <Skeleton className="h-5 w-16" />
      <div className="flex items-center gap-4">
        <Skeleton className="size-12 rounded-xl" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>
      <Skeleton className="h-9 w-64" />
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
