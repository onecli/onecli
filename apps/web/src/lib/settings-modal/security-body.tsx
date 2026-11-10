import { PageHeader, PlainPageHeaders } from "@dashboard/page-header";
import { isEntitled } from "@onecli/api/lib/entitlements";
import { EnterpriseLockedCard } from "@/lib/components/enterprise-locked-card";
import OrgSsoPage from "@/ee/settings/org-sso-page";
import GroupsPage from "@/ee/groups/groups-page";

const SSO_DETAILS = [
  {
    title: "SAML & OIDC sign-in",
    description:
      "Connect Okta, Entra ID, Google Workspace, or any identity provider.",
  },
  {
    title: "Verified email domains",
    description: "Prove you own your company's domains so SSO can be trusted.",
  },
  {
    title: "Enforcement",
    description: "Require everyone on your domain to sign in through your IdP.",
  },
  {
    title: "SCIM provisioning",
    description: "Create, update, and deactivate members from your IdP.",
  },
];

/**
 * Settings > Security & SSO: how people sign in to the org. The SSO page,
 * with Groups under its Provisioning tab (a group is what SCIM provisions).
 *
 * The license gate for both, server side: unlicensed, the locked card
 * renders INSTEAD of the pages, so neither one's reads ever run.
 */
export const SecurityBody = () => {
  if (!isEntitled()) {
    return (
      <div className="flex flex-1 flex-col gap-6">
        <PageHeader
          title="Single sign-on"
          character="drop"
          description="Connect your identity provider so your team signs in with their company accounts."
        />
        <EnterpriseLockedCard
          feature="sso"
          title="Single sign-on"
          description="Connect your identity provider for SAML/OIDC sign-in, enforce it org-wide, and provision members via SCIM."
          details={SSO_DETAILS}
        />
      </div>
    );
  }
  return (
    <OrgSsoPage
      provisioningExtra={
        <PlainPageHeaders>
          <GroupsPage />
        </PlainPageHeaders>
      }
    />
  );
};
