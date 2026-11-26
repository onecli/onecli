import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

/** An old URL: the shared apps index had no page of its own (the Apps tab
 *  was the root). It is Settings > Shared apps now; straight there, not
 *  through `settings/global-connections` (a second redirect). */
export default async function GlobalAppsIndexPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  await redirectToSettingsModal({ organizationId: orgId }, "shared-apps");
}
