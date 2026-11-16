import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

/**
 * An old URL from before App availability moved under Organization
 * Settings (bookmarks, links already handed out). It is Settings > Shared
 * apps now; straight there, not through `settings/app-availability` (a
 * second redirect).
 */
export default async function Page({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  await redirectToSettingsModal({ organizationId: orgId }, "shared-apps");
}
