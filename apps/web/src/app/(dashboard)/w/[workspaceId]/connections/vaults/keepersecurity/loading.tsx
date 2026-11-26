import { Skeleton } from "@onecli/ui/components/skeleton";

export default function KeeperSecurityLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-4 w-12" />

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-5 w-12 rounded-full" />
        </div>
        <Skeleton className="h-4 w-72" />
      </div>

      <Skeleton className="h-48 w-full max-w-md rounded-lg" />
    </div>
  );
}
