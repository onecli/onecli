import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { WorkspaceApiKeyCard } from "./_components/workspace-api-key-card";

export const metadata: Metadata = {
  title: "API Key",
};

export default function WorkspaceApiKeyPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="API Key"
        description="Your personal API key for this workspace. The CLI and SDK sign in with it."
      />
      <WorkspaceApiKeyCard />
    </div>
  );
}
