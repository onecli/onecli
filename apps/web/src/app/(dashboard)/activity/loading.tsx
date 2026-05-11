import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function ActivityLoading() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Activity"
        description="Request logs from your gateway. Bodies and query strings are never recorded."
      />
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-36 rounded-lg" />
        <Skeleton className="h-8 w-16 rounded-lg" />
      </div>
      <div className="rounded-lg border">
        <div className="border-b px-4 py-3">
          <div className="flex items-center gap-4">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="ml-auto h-3 w-10" />
          </div>
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b last:border-b-0 px-4 py-3.5"
          >
            <Skeleton className="h-3.5 w-14" />
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-5 w-10 rounded-full" />
            <Skeleton className="h-3.5 w-44" />
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-5 w-10 rounded-full" />
            <Skeleton className="ml-auto h-3.5 w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}
