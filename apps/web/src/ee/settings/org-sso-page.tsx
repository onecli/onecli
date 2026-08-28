import { PageHeader } from "@dashboard/page-header";
import { OrgSsoCard } from "./_components/org-sso-card";
import { RequireSsoCard } from "./_components/require-sso-card";
import { ScimCard } from "./_components/scim-card";

export default function OrgSsoPage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Single sign-on"
        description="Connect your identity provider so your team signs in with their company accounts."
      />
      <OrgSsoCard />
      <RequireSsoCard />
      <ScimCard />
    </div>
  );
}
