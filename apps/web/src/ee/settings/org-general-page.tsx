import { PageHeader } from "@dashboard/page-header";
import { getOrganizationData } from "./actions";
import { OrgDetailsForm } from "./_components/org-details-form";
import { DeleteOrgCard } from "./_components/delete-org-card";

export default async function OrgGeneralPage() {
  const org = await getOrganizationData();

  if (!org) {
    return (
      <div className="flex flex-1 flex-col gap-4">
        <PageHeader
          title="Organization"
          description="You are not part of any organization."
        />
      </div>
    );
  }

  const isOwner = org.role === "owner";
  const isAdmin = org.role === "admin" || isOwner;

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Organization"
        description={
          isAdmin
            ? "Rename or delete your organization."
            : "View your organization details."
        }
      />

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Organization details</h2>
        <OrgDetailsForm orgId={org.id} orgName={org.name} readOnly={!isAdmin} />
      </section>

      {isOwner && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Danger zone</h2>
          <DeleteOrgCard
            orgId={org.id}
            orgName={org.name}
            role={org.role}
            workspaces={org.workspaces}
          />
        </section>
      )}
    </div>
  );
}
