import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ orgId: string }>;
}

/** An old URL: Settings > Organization > General. */
export default async function Page({ params }: Props) {
  const { orgId } = await params;
  await redirectToSettingsModal({ organizationId: orgId }, "general");
}
