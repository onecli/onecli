import { requireAccessibleWorkspace } from "@/lib/workspaces/workspace-access";
import { SettingsSlot } from "@/lib/settings-modal/settings-slot";

interface Props {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * `?settings=<page>` on any `/w/<id>/...` URL: the workspace-scoped modal,
 * with the org pages reachable too (a workspace implies its org). A
 * catch-all for the reason the org slot gives.
 */
export default async function WorkspaceSettingsSlot({
  params,
  searchParams,
}: Props) {
  // No param, no modal: skip the access read on every plain page view.
  if (!(await searchParams).settings) return null;
  const { workspaceId } = await params;
  const workspace = await requireAccessibleWorkspace(workspaceId);
  return (
    <SettingsSlot
      scope={{ organizationId: workspace.organizationId, workspaceId }}
      searchParams={searchParams}
    />
  );
}
