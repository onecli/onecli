import { PageHeader } from "@dashboard/page-header";
import { SettingsSection } from "@dashboard/settings-section";
import { API_KEYS_DOCS_URL, DocsLink } from "@/lib/components/docs-link";
import { WorkspaceApiKeyCard } from "@/app/(dashboard)/w/[workspaceId]/settings/api-key/_components/workspace-api-key-card";
import { OrgApiKeyCard } from "@/lib/settings/org-api-key-card";

/** Settings > API keys: the caller's personal keys. The workspace key when
 *  there is a workspace in the URL (the CLI and SDK sign in with it), and
 *  the org key for admins (the org-level API). */
export const ApiKeysBody = ({
  hasWorkspace,
  isAdmin,
}: {
  hasWorkspace: boolean;
  isAdmin: boolean;
}) => (
  <div className="flex flex-1 flex-col gap-8">
    <PageHeader
      title="API keys"
      character="drop-key"
      description="Call the OneCLI API from your own code. Keys act as you."
      action={<DocsLink href={API_KEYS_DOCS_URL} label="API docs" />}
    />
    {hasWorkspace && (
      <SettingsSection
        title="This workspace"
        description="Your personal API key for this workspace. The CLI and SDK sign in with it."
      >
        <WorkspaceApiKeyCard />
      </SettingsSection>
    )}
    {isAdmin && (
      <SettingsSection
        title="Organization"
        description="Your personal organization-level API key for OneCLI services."
      >
        <OrgApiKeyCard />
      </SettingsSection>
    )}
  </div>
);
