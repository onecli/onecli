import { isEntitled } from "@onecli/api/lib/entitlements";
import { getApp } from "@onecli/api/apps/registry";
import TeamPage from "@/lib/team/team-page";
import OrgGeneralPage from "@/ee/settings/org-general-page";
import OrgPolicyPage from "@/lib/policy/org-policy-page";
import OrgWorkspacesPage from "@/lib/workspaces/page";
import WorkspaceSettingsPage from "@/lib/workspaces/settings-page";
import { ChannelsSettingsContent } from "@/app/(dashboard)/org/[orgId]/(admin)/channels/_components/channels-settings-content";
import { ActivityContent } from "@/app/(dashboard)/w/[workspaceId]/activity/_components/activity-content";
import { WorkspaceAppsBody } from "./workspace-apps-body";
import { SharedAppsBody } from "./shared-apps-body";
import { WorkspaceAppDetailBody } from "./workspace-app-detail-body";
import { SharedAppDetailBody } from "./shared-app-detail-body";
import { VaultSetupBody, isVaultProvider } from "./vault-setup-body";
import { SecurityBody } from "./security-body";
import { BillingBody } from "./billing-body";
import { ProfileBody } from "./profile-body";
import { ApiKeysBody } from "./api-keys-body";
import type { SettingsScope } from "./resolve";
import type { SettingsPageId, SettingsViewer } from "./pages";

/**
 * What each modal page shows. The bodies ARE the existing pages, composed
 * where two of them merge (Security & SSO = SSO + Groups, Billing & usage
 * = Billing + Usage, Profile = Preferences + SSH keys + Audit log), so a
 * fix to one is a fix to the modal page.
 *
 * Server component. The pages read their org/workspace from the request
 * headers the proxy set from the URL, the same as at their own routes.
 *
 * The connections pages have sub-pages (an app's detail, a vault's setup):
 * inside the modal they are the page-local `?app=` / `?vault=` params, so a
 * click on an app stays in the modal. An unknown provider shows the list,
 * as if the param were not there.
 */

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** The app registry's ids are `[a-z0-9-]`; anything else is not a provider. */
const providerParam = (value: string | string[] | undefined) => {
  const v = single(value);
  return v && /^[a-z0-9-]{1,64}$/.test(v) ? v : undefined;
};

export const SettingsPageBody = ({
  page,
  scope,
  viewer,
  searchParams,
}: {
  page: SettingsPageId;
  scope: SettingsScope;
  viewer: SettingsViewer;
  searchParams: Record<string, string | string[] | undefined>;
}) => {
  const { workspaceId, organizationId } = scope;
  switch (page) {
    case "members":
      return <TeamPage />;
    case "apps": {
      const app = providerParam(searchParams.app);
      if (app && workspaceId && getApp(app)) {
        return (
          <WorkspaceAppDetailBody
            provider={app}
            workspaceId={workspaceId}
            organizationId={organizationId}
          />
        );
      }
      const vault = providerParam(searchParams.vault);
      if (vault && isVaultProvider(vault)) {
        return <VaultSetupBody provider={vault} />;
      }
      return <WorkspaceAppsBody />;
    }
    case "activity":
      return <ActivityContent />;
    case "workspace":
      // Workspace pages only open on a workspace URL (`visibleSettingsPages`).
      return workspaceId ? (
        <WorkspaceSettingsPage workspaceId={workspaceId} />
      ) : null;
    case "general":
      return <OrgGeneralPage />;
    case "shared-apps": {
      const app = providerParam(searchParams.app);
      if (app && getApp(app)) {
        return (
          <SharedAppDetailBody provider={app} organizationId={organizationId} />
        );
      }
      return <SharedAppsBody entitled={isEntitled()} />;
    }
    case "rules":
      return <OrgPolicyPage />;
    case "slack":
      return <ChannelsSettingsContent />;
    case "workspaces":
      return <OrgWorkspacesPage />;
    case "security":
      return <SecurityBody />;
    case "billing":
      return <BillingBody />;
    case "profile":
      return <ProfileBody />;
    case "api-keys":
      return (
        <ApiKeysBody
          hasWorkspace={viewer.hasWorkspace}
          isAdmin={viewer.isAdmin}
        />
      );
  }
};
