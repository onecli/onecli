import { hasAppConfig } from "@onecli/api/services/app-config-service";
import { AppDetail } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/app-detail";
import { loadAppDetail } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/load-app-detail";

/**
 * An app's detail inside Settings > Apps (`?settings=apps&app=<p>`): the
 * route page's `AppDetail`, fed by the same loader. The route page reads
 * its scope from the request headers; here the scope is explicit, and
 * access is the slot's (a workspace page only renders on a workspace the
 * viewer may open).
 *
 * Server component, not a server action: these reads are not callable
 * from the client, so naming a scope here opens no door.
 */
export const WorkspaceAppDetailBody = async ({
  provider,
  workspaceId,
  organizationId,
}: {
  provider: string;
  workspaceId: string;
  organizationId: string;
}) => {
  // The workspace → org credential chain, as `checkAppConfigExists` walks it.
  const data = await loadAppDetail(
    provider,
    async (p) =>
      (await hasAppConfig({ workspaceId }, p)) ||
      hasAppConfig({ organizationId }, p),
  );
  return <AppDetail {...data} />;
};
