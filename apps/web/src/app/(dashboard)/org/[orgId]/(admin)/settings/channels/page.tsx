import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** An old URL from when Channels sat under Organization Settings: it is
 *  Settings > Slack now. Straight there, not through `channels` (a second
 *  redirect), with the query along like that page's. */
export default async function Page({ params, searchParams }: Props) {
  const { orgId } = await params;
  await redirectToSettingsModal(
    { organizationId: orgId },
    "slack",
    await searchParams,
  );
}
