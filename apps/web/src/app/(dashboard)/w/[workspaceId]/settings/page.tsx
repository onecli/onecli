import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ workspaceId: string }>;
}

/** An old URL: the settings index opened General, now Settings > Workspace
 *  > Settings. Straight there, not through `settings/general` (a second
 *  redirect). */
export default async function WorkspaceSettingsIndex({ params }: Props) {
  const { workspaceId } = await params;
  await redirectToSettingsModal({ workspaceId }, "workspace");
}
