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
        title="Shared Connections"
        description="Apps, secrets, and LLM keys connected once and shared with every workspace. Each workspace chooses which of its agents use them."
      />
      <div className="space-y-6">
        <GlobalConnectionsTabs />
        {children}
      </div>
    </>
  );
}
