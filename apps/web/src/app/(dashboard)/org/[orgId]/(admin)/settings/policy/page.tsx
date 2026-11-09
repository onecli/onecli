import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

export { metadata } from "@/lib/policy/org-policy-page";

interface Props {
  params: Promise<{ orgId: string }>;
}

/** An old URL: Settings > Organization > Rules. */
export default async function Page({ params }: Props) {
  const { orgId } = await params;
  await redirectToSettingsModal({ organizationId: orgId }, "rules");
}
