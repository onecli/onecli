import { notFound } from "next/navigation";
import { getApp } from "@onecli/api/apps/registry";
import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ provider: string; orgId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/** Settings > Shared apps, the app's detail
 *  (`?settings=shared-apps&app=<provider>`). An unknown provider 404s, as
 *  it always did. */
const GlobalAppDetailPage = async ({ params, searchParams }: Props) => {
  const { provider, orgId } = await params;
  if (!getApp(provider)) notFound();
  await redirectToSettingsModal({ organizationId: orgId }, "shared-apps", {
    ...(await searchParams),
    app: provider,
  });
};

export default GlobalAppDetailPage;
