import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** An old URL: Settings > Apps, Vaults tab. */
export default async function ConnectionsVaultsPage({
  params,
  searchParams,
}: Props) {
  const { workspaceId } = await params;
  await redirectToSettingsModal({ workspaceId }, "apps", {
    ...(await searchParams),
    tab: "vaults",
  });
}
