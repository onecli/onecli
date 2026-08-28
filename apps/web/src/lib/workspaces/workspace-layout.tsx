import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { getServerSession } from "@/lib/auth/server";
import { db } from "@onecli/db";
import { canAccessWorkspaceAsUser } from "@onecli/api/services/workspace-access-check";
import { WorkspaceNameBroadcast } from "@/lib/workspaces/workspace-name-broadcast";

// Lazy: the quota banner is Cloud billing UI (renders nothing elsewhere) — a
// dynamic import keeps this free layout from statically depending on it.
const OverQuotaBanner = dynamic(() =>
  import("@/ee/billing/_components/over-quota-banner").then(
    (m) => m.OverQuotaBanner,
  ),
);

interface Props {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}

export default async function WorkspaceLayout({ children, params }: Props) {
  const { workspaceId } = await params;
  const session = await getServerSession();
  if (!session) redirect("/auth/login");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });
  if (!user) redirect("/auth/login");

  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      organization: {
        members: { some: { userId: user.id, status: { not: "suspended" } } },
      },
    },
    select: {
      id: true,
      name: true,
      organizationId: true,
    },
  });
  if (!workspace) {
    redirect("/org");
  }
  // Usage is bindings-only since step 13b — the creator arm was dropped, so on
  // RBAC deployments (cloud, licensed self-host) every user must hold a
  // WorkspaceAccess binding (direct or group) or be an org admin/owner to open
  // the workspace; non-RBAC deployments enforce no roles. The provider-driven
  // shared check is the same one the auth middleware runs, so the layout and
  // the API can never disagree. The findFirst above already excludes
  // suspended members.
  const allowed = await canAccessWorkspaceAsUser(user.id, workspace);
  if (!allowed) {
    redirect("/org");
  }

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
        <OverQuotaBanner />
        {children}
      </div>
    </>
  );
}
