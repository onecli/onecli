import { PageHeader } from "@dashboard/page-header";
import { GlobalConnectionsTabs } from "./global-connections-tabs";

export default function GlobalConnectionsTabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <PageHeader
        title="Global Connections"
        description="Organization-wide app integrations, custom secrets, and LLM keys shared across all workspaces."
      />
      <div className="space-y-6">
        <GlobalConnectionsTabs />
        {children}
      </div>
    </>
  );
}
