import { PageHeader } from "@dashboard/page-header";
import { OrgApiKeyCard } from "@/lib/settings/org-api-key-card";

export default function OrgApiKeysPage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="API Keys"
        description="Your personal organization-level API key for OneCLI services."
      />
      <OrgApiKeyCard />
    </div>
  );
}
