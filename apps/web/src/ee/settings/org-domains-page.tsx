import { PageHeader } from "@dashboard/page-header";
import { OrgDomainsCard } from "./_components/org-domains-card";

export default function OrgDomainsPage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Domains"
        description="Claim your company's email domains and verify them via DNS. Verified domains are the foundation for single sign-on."
      />
      <OrgDomainsCard />
    </div>
  );
}
