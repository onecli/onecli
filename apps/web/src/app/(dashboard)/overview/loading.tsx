import { Card, CardContent, CardHeader } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function OverviewLoading() {
  return (
    <div className="flex flex-1 flex-col gap-6 max-w-5xl">
      <PageHeader
        title="Overview"
        description="Your OneCLI dashboard at a glance."
      />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-56" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-full rounded-md" />
        </CardContent>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-6">
          <Skeleton className="h-5 w-20 mb-3" />
          <Skeleton className="h-8 w-8" />
        </Card>
        <Card className="p-6">
          <Skeleton className="h-5 w-20 mb-3" />
          <Skeleton className="h-8 w-8" />
        </Card>
      </div>
    </div>
  );
}
