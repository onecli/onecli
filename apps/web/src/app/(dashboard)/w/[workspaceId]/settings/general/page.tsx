import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ workspaceId: string }>;
}

/** An old URL: Settings > Workspace > Settings. */
export default async function WorkspaceGeneralPage({ params }: Props) {
  const { workspaceId } = await params;
  await redirectToSettingsModal({ workspaceId }, "workspace");
}
