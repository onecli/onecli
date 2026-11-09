import { PageHeader } from "@dashboard/page-header";
import { SettingsSection } from "@dashboard/settings-section";
import { IS_CLOUD } from "@/lib/env";
import { ProfileForm } from "@/app/(dashboard)/account/preferences/_components/profile-form";
import { ChangePasswordCard } from "@/lib/account/_components/change-password-card";
import { DeleteAccountCard } from "@/lib/account/_components/delete-account-card";
import { SshKeysCard } from "@/lib/account/_components/ssh-keys-card";
import { AuditLogsTable } from "@/lib/account/_components/audit-logs-table";
import { getAccountPreferencesData, getAuditLogs } from "@/lib/account/actions";

/** Settings > Profile: the account pages as one, in the order you need
 *  them: who you are, how you sign in, your SSH keys, what your account
 *  did. */
export const ProfileBody = async () => {
  const [{ email, hasPassword }, logs] = await Promise.all([
    getAccountPreferencesData(),
    getAuditLogs(),
  ]);
  return (
    <div className="flex flex-1 flex-col gap-8">
      <PageHeader
        title="Profile"
        character="cloud-mug"
        description="How you appear to teammates and agents."
      />
      <ProfileForm />
      {!IS_CLOUD && <ChangePasswordCard hasPassword={hasPassword} />}
      <SettingsSection
        title="SSH keys"
        description="Public keys that identify you when connecting to your agents over SSH. Register a key once, then mint certificates from it in any agent's settings."
      >
        <SshKeysCard />
      </SettingsSection>
      <SettingsSection
        title="Audit log"
        description="Recent account activity and security events."
      >
        <AuditLogsTable logs={logs} />
      </SettingsSection>
      <SettingsSection title="Danger zone">
        <DeleteAccountCard email={email} />
      </SettingsSection>
    </div>
  );
};
