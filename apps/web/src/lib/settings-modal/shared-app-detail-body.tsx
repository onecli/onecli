import { hasAppConfig } from "@onecli/api/services/app-config-service";
import { AppDetail } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/app-detail";
import { loadAppDetail } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/load-app-detail";

/**
 * An app's detail inside Settings > Shared apps
 * (`?settings=shared-apps&app=<p>`): the org-scope `AppDetail`. The URL
 * beneath the modal may name a workspace while this page acts on the org,
 * so the scope is explicit. Access is the slot's: the page only renders
 * for an org admin.
 *
 * Server component, not a server action: these reads are not callable
 * from the client, so naming a scope here opens no door.
 */
export const SharedAppDetailBody = async ({
  provider,
  organizationId,
}: {
  provider: string;
  organizationId: string;
}) => {
  const data = await loadAppDetail(provider, (p) =>
    hasAppConfig({ organizationId }, p),
  );
  return <AppDetail {...data} pageScope="organization" />;
};
