import { checkAppConfigExists } from "@/lib/actions/app-config";
import { AppDetail } from "../../_components/app-detail";
import { loadAppDetail } from "../../_components/load-app-detail";

interface Props {
  params: Promise<{ provider: string }>;
}

const AppDetailPage = async ({ params }: Props) => {
  const { provider } = await params;
  const data = await loadAppDetail(provider, checkAppConfigExists);

  return <AppDetail {...data} />;
};

export default AppDetailPage;
