import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";

export default function LlmsTabLoading() {
  return (
    <div className="space-y-4">
      {[1, 2].map((i) => (
        <Card key={i} className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-lg" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
            <Skeleton className="size-8 rounded-md" />
          </div>
        </Card>
      ))}
    </div>
  );
}
