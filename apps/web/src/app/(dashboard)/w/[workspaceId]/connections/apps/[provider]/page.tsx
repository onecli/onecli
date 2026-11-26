import { notFound } from "next/navigation";
import { getApp } from "@onecli/api/apps/registry";
import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ workspaceId: string; provider: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Settings > Apps, the app's detail (`?settings=apps&app=<provider>`),
 *  its query (`?connected=`, `?reconnect=`, `?org_access=`, an agent's
 *  connect link) along. An unknown provider 404s, as it always did. */
const AppDetailPage = async ({ params, searchParams }: Props) => {
  const { workspaceId, provider } = await params;
  if (!getApp(provider)) notFound();
  await redirectToSettingsModal({ workspaceId }, "apps", {
    ...(await searchParams),
    app: provider,
  });
};

export default AppDetailPage;
