import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { ApiKeyCard } from "@/app/(dashboard)/overview/_components/api-key-card";

export const metadata: Metadata = {
  title: "API Keys",
};

export default function ApiKeysPage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="API Keys"
        description="Manage your API keys for OneCLI services."
      />
      <ApiKeyCard />
    </div>
  );
}
