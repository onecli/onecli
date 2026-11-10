import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** An old URL: Settings > Organization > Billing & usage. Stripe's checkout
 *  and portal return here, so their `?checkout=success` travels along: the
 *  plan usage re-reads on it. */
export default async function Page({ params, searchParams }: Props) {
  const { orgId } = await params;
  await redirectToSettingsModal(
    { organizationId: orgId },
    "billing",
    await searchParams,
  );
}
