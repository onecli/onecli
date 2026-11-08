import dynamic from "next/dynamic";
import { requireAccessibleWorkspace } from "@/lib/workspaces/workspace-access";
import { WorkspaceNameBroadcast } from "@/lib/workspaces/workspace-name-broadcast";

// Lazy: the quota banner is Cloud billing UI (renders nothing elsewhere) — a
// dynamic import keeps this free layout from statically depending on it.
const OverQuotaBanner = dynamic(() =>
  import("@/ee/billing/_components/over-quota-banner").then(
    (m) => m.OverQuotaBanner,
  ),
);
const PaymentIssueBanner = dynamic(() =>
  import("@/ee/billing/_components/payment-issue-banner").then(
    (m) => m.PaymentIssueBanner,
  ),
);

interface Props {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}

export default async function WorkspaceLayout({ children, params }: Props) {
  const { workspaceId } = await params;
  const workspace = await requireAccessibleWorkspace(workspaceId);

  return (
    <>
      <WorkspaceNameBroadcast
        workspaceId={workspaceId}
        workspaceName={workspace.name}
        organizationId={workspace.organizationId}
      />
      {/* A column, because the banner is a SIBLING of the page: the agent
          page is handed the dashboard's raw flex ROW cell, where two loose
          siblings would render side by side instead of stacked. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PaymentIssueBanner />
        <OverQuotaBanner />
        {children}
      </div>
    </>
  );
}
