import { db } from "@onecli/db";
import { PageHeader } from "@dashboard/page-header";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import { getUserRole } from "@onecli/api/ee/services/authorization-service";
import { normalizePlan, isPlanAtLeast } from "@onecli/api/ee/billing/plans";
import { getTeamMembers } from "@/lib/team/actions";
import { getOrgSubscriptionStatus } from "@/ee/team/actions";
import { MemberList } from "./_components/member-list";
import { InviteButton } from "./_components/invite-button";
import { TeamUpgradeBanner } from "@/ee/team/_components/team-upgrade-banner";

export default async function TeamPage() {
  const { userId, organizationId } = await resolveOrgContext();

  const [role, members, subscriptionStatus, org] = await Promise.all([
    getUserRole(userId, organizationId),
    getTeamMembers(),
    getOrgSubscriptionStatus(),
    db.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { name: true },
    }),
  ]);
  const isAdmin = role === "admin" || role === "owner";
  const plan = normalizePlan(subscriptionStatus);

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <PageHeader
          title="Members"
          description="Manage members and roles for your organization."
        />
        {isAdmin && <InviteButton />}
      </div>

      {isAdmin && members.length >= 2 && !isPlanAtLeast(plan, "team") && (
        <TeamUpgradeBanner />
      )}

      <MemberList
        members={members}
        currentUserId={userId}
        isAdmin={isAdmin}
        orgName={org.name}
      />
    </div>
  );
}
