import { checkOrgAppConfigExists } from "@/lib/actions/org-app-config";
import { orgConnectionsPath } from "@/lib/navigation";
import { AppDetail } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/app-detail";
import { loadAppDetail } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/load-app-detail";

interface Props {
  params: Promise<{ provider: string; orgId: string }>;
}

const GlobalAppDetailPage = async ({ params }: Props) => {
  const { provider, orgId } = await params;
  const data = await loadAppDetail(provider, checkOrgAppConfigExists);

  return (
    <AppDetail
      {...data}
      pageScope="organization"
      backPath={orgConnectionsPath(orgId)}
    />
  );
};

export default GlobalAppDetailPage;
