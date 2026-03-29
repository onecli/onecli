import { PageHeader } from "@dashboard/page-header";
import { ConnectionsTabs } from "../_components/connections-tabs";

export default function ConnectionsTabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <PageHeader
        title="Connections"
        description="Manage your app integrations, API secrets, and external vaults in one place."
      />
      <div className="space-y-6">
        <ConnectionsTabs />
        {children}
      </div>
    </>
  );
}
