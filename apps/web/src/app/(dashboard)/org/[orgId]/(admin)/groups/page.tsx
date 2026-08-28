import GroupsPage from "@/ee/groups/groups-page";
import { isEntitled } from "@onecli/api/lib/entitlements";
import { EnterpriseLockedCard } from "@/lib/components/enterprise-locked-card";

export default function Page() {
  // Directory groups + role mappings (#68/#69) are licensed — dark unlicensed.
  if (!isEntitled()) {
    return (
      <EnterpriseLockedCard
        feature="groups"
        description="Organize members into directory groups, sync them from your IdP via SCIM, and map groups to org roles."
      />
    );
  }
  return <GroupsPage />;
}
