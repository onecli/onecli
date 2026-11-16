import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** An old URL: Settings > Apps, the 1Password setup
 *  (`?settings=apps&vault=onepassword`). */
export default async function OnePasswordPage({ params, searchParams }: Props) {
  const { workspaceId } = await params;
  await redirectToSettingsModal({ workspaceId }, "apps", {
    ...(await searchParams),
    vault: "onepassword",
  });
}
