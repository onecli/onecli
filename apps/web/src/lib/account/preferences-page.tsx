import { PageHeader } from "@dashboard/page-header";
import { ProfileForm } from "@/app/(dashboard)/account/preferences/_components/profile-form";
import { IS_CLOUD } from "@/lib/env";
import { getAccountPreferencesData } from "./actions";
import { ChangePasswordCard } from "./_components/change-password-card";
import { DeleteAccountCard } from "./_components/delete-account-card";

export default async function PreferencesPage() {
  const { email, hasOrgs, hasPassword } = await getAccountPreferencesData();

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Preferences"
        description="Manage your account profile and preferences."
      />
      <ProfileForm />

      {/* Self-hosted only: cloud identities live in Cognito, which owns its
          own password flow. */}
      {!IS_CLOUD && <ChangePasswordCard hasPassword={hasPassword} />}

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Danger zone</h2>
        <DeleteAccountCard email={email} hasOrgs={hasOrgs} />
      </section>
    </div>
  );
}
