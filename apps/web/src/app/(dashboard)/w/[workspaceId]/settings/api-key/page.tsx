import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ workspaceId: string }>;
}

/** An old URL: Settings > Account > API keys. */
export default async function WorkspaceApiKeyPage({ params }: Props) {
  const { workspaceId } = await params;
  await redirectToSettingsModal({ workspaceId }, "api-keys");
}
