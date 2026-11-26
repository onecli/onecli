import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** An old URL: Settings > Organization > Slack. The `?connected=slack`
 *  install return travels along. */
export default async function ChannelsSettingsPage({
  params,
  searchParams,
}: Props) {
  const { orgId } = await params;
  await redirectToSettingsModal(
    { organizationId: orgId },
    "slack",
    await searchParams,
  );
}
