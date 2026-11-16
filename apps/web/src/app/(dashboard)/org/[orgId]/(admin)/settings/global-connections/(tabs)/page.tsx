import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** An old URL: Settings > Organization > Shared apps. */
export default async function OrgConnectionsPage({
  params,
  searchParams,
}: Props) {
  const { orgId } = await params;
  await redirectToSettingsModal(
    { organizationId: orgId },
    "shared-apps",
    await searchParams,
  );
}
