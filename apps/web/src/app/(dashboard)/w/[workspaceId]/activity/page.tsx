import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** An old URL: Settings > Activity, opened over the workspace's first
 *  agent, filters intact. */
export default async function ActivityPage({ params, searchParams }: Props) {
  const { workspaceId } = await params;
  await redirectToSettingsModal(
    { workspaceId },
    "activity",
    await searchParams,
  );
}
