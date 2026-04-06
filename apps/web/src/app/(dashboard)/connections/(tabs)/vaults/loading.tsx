import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";

export default function VaultsTabLoading() {
  return (
    <div className="space-y-4">
      <Card className="p-6">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-44" />
          </div>
        </div>
      </Card>
    </div>
  );
}
