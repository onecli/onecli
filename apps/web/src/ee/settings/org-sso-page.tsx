import { Suspense } from "react";
import { PageHeader } from "@dashboard/page-header";
import { OrgDomainsCard } from "./_components/org-domains-card";
import { OrgSsoCard } from "./_components/org-sso-card";
import { RequireSsoCard } from "./_components/require-sso-card";
import { ScimCard } from "./_components/scim-card";
import { SsoTabs } from "./_components/sso-tabs";

/**
 * The whole SSO story on one page, in two tabs. SSO: the identity provider
 * and the email domains it is trusted for on the left, enforcement beside
 * them (it can only turn on once both are in place, and reads as the
 * switch over them). Provisioning: SCIM, and whatever the host page adds
 * under it (the Settings modal adds Groups).
 */
export default function OrgSsoPage({
  provisioningExtra,
}: {
  provisioningExtra?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        character="drop"
        title="Single sign-on"
        description="Connect your identity provider so your team signs in with their company accounts."
      />
      <Suspense fallback={null}>
        <SsoTabs
          sso={
            <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_272px]">
              <div className="flex min-w-0 flex-col gap-5">
                <OrgSsoCard />
                <OrgDomainsCard />
              </div>
              <RequireSsoCard />
            </div>
          }
          provisioning={
            <div className="flex flex-col gap-10">
              <ScimCard />
              {provisioningExtra}
            </div>
          }
        />
      </Suspense>
    </div>
  );
}
