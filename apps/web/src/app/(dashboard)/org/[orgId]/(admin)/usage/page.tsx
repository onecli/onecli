import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** An old URL: usage lives under Settings > Billing & usage. */
export default async function Page({ params, searchParams }: Props) {
  const { orgId } = await params;
  await redirectToSettingsModal(
    { organizationId: orgId },
    "billing",
    await searchParams,
  );
}
