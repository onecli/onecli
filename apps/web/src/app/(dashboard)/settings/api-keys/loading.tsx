import { Card, CardContent, CardHeader } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function ApiKeysLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4 max-w-5xl">
      <PageHeader
        title="API Keys"
        description="Manage your API keys for OneCLI services."
      />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-full rounded-md" />
        </CardContent>
      </Card>
    </div>
  );
}
