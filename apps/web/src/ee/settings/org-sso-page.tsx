import { PageHeader } from "@dashboard/page-header";
import { SettingsSection } from "@dashboard/settings-section";
import { OrgDomainsCard } from "./_components/org-domains-card";
import { OrgSsoCard } from "./_components/org-sso-card";
import { RequireSsoCard } from "./_components/require-sso-card";
import { ScimCard } from "./_components/scim-card";

/**
 * One page for the whole SSO story, in the order it is set up. Domains is
 * step 1 rather than its own settings tab: a verified domain has no use
 * outside SSO (it is the trust leg every IdP assertion is joined against,
 * and enforcement cannot be enabled without one), so splitting it out hid
 * the prerequisite behind a second tab.
 *
 * Enforcement and Provisioning carry no section description: their cards
 * open with their own label and explanation, and repeating it above them
 * read as an echo.
 */
export default function OrgSsoPage() {
  return (
    <div className="flex flex-1 flex-col gap-8">
      <PageHeader
        title="Single sign-on"
        description="Connect your identity provider so your team signs in with their company accounts."
      />
      <SettingsSection
        title="Domains"
        description="Claim your company's email domains and verify them via DNS. SSO can only be trusted or enforced for a verified domain."
      >
        <OrgDomainsCard />
      </SettingsSection>
      <SettingsSection
        title="Identity provider"
        description="Connect your SAML or OIDC provider."
      >
        <OrgSsoCard />
      </SettingsSection>
      <SettingsSection title="Enforcement">
        <RequireSsoCard />
      </SettingsSection>
      <SettingsSection title="Provisioning">
        <ScimCard />
      </SettingsSection>
    </div>
  );
}
