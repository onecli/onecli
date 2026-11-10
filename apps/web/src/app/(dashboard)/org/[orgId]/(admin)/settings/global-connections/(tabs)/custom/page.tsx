import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** An old URL: Settings > Shared apps, Custom tab. */
export default async function OrgCustomSecretsPage({
  params,
  searchParams,
}: Props) {
  const { orgId } = await params;
  await redirectToSettingsModal({ organizationId: orgId }, "shared-apps", {
    ...(await searchParams),
    tab: "custom",
  });
}
