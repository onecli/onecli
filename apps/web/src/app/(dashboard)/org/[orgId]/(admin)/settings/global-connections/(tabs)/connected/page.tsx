import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** An old URL: Settings > Shared apps, Connected tab. */
export default async function OrgConnectedPage({
  params,
  searchParams,
}: Props) {
  const { orgId } = await params;
  await redirectToSettingsModal({ organizationId: orgId }, "shared-apps", {
    ...(await searchParams),
    tab: "connected",
  });
}
