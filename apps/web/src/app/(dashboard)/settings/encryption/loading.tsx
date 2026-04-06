import { Card, CardContent, CardHeader } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function EncryptionLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4 max-w-5xl">
      <PageHeader
        title="Encryption"
        description="Configure how your secrets are encrypted."
      />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-56" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-full rounded-md" />
        </CardContent>
      </Card>
    </div>
  );
}
