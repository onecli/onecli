import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server";
import { canCreateOrganization } from "@onecli/api/ee/services/quota-service";
import { isEntitled } from "@onecli/api/lib/entitlements";
import { getUserDefaultOrgId } from "@/lib/auth/default-org";
import { EnterpriseLockedCard } from "@/lib/components/enterprise-locked-card";
import { CreateOrgForm } from "./_components/create-org-form";

export default async function CreateOrgPage() {
  const session = await getServerSession();
  if (!session) redirect("/auth/login");

  // At the org cap — explain rather than bounce. Unlicensed the cap is the
  // license clamp (#64: one owned org), so the honest answer is the license
  // card; on cloud (or licensed with an operator cap) keep the old redirect
  // to the user's org, since a form whose submit can only fail helps nobody.
  if (!(await canCreateOrganization(session.id))) {
    if (!isEntitled()) {
      return (
        <div className="flex flex-1 items-center justify-center p-6">
          <EnterpriseLockedCard
            feature="multi_org"
            description="Run several organizations side by side and switch between them."
          />
        </div>
      );
    }
    const orgId = await getUserDefaultOrgId();
    redirect(orgId ? `/org/${orgId}/workspaces` : "/");
  }

  return <CreateOrgForm />;
}
