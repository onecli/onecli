import OrgDomainsPage from "@/ee/settings/org-domains-page";
import { isEntitled } from "@onecli/api/lib/entitlements";
import { EnterpriseLockedCard } from "@/lib/components/enterprise-locked-card";

export default function Page() {
  // Verified email domains (#73) belong to the SSO feature — dark unlicensed.
  if (!isEntitled()) {
    return (
      <EnterpriseLockedCard
        feature="sso"
        description="Prove ownership of your email domains to enable home-realm discovery and SSO enforcement."
      />
    );
  }
  return <OrgDomainsPage />;
}
