import { Card, CardContent, CardHeader } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";

export default function ApprovalPathsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      {[0, 1].map((i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-9 w-full rounded-md" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
