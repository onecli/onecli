import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

/** An old URL: the org settings index opened General, now Settings >
 *  Organization > General. Straight there, not through `settings/general`
 *  (a second redirect). */
export default async function OrgSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  await redirectToSettingsModal({ organizationId: orgId }, "general");
}
