import OrgSsoPage from "@/ee/settings/org-sso-page";
import { isEntitled } from "@onecli/api/lib/entitlements";
import { EnterpriseLockedCard } from "@/lib/components/enterprise-locked-card";

export default function Page() {
  // SAML/OIDC SSO (#74-78) is licensed — dark unlicensed.
  if (!isEntitled()) {
    return (
      <EnterpriseLockedCard
        feature="sso"
        description="Connect your identity provider for SAML/OIDC sign-in, enforce it org-wide, and provision members via SCIM."
      />
    );
  }
  return <OrgSsoPage />;
}
