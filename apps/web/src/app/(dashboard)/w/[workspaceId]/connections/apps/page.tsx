import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

/** An old URL: the apps index had no page of its own (the Apps tab was the
 *  root). It is Settings > Apps now; straight there, not through
 *  `connections` (a second redirect). */
export default async function AppsRedirectPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await redirectToSettingsModal({ workspaceId }, "apps");
}
