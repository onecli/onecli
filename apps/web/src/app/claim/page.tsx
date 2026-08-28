import ClaimPage from "@/ee/team/claim-page";
import { isEntitled } from "@onecli/api/lib/entitlements";
import { EnterpriseLockedCard } from "@/lib/components/enterprise-locked-card";

export default async function Page(
  props: React.ComponentProps<typeof ClaimPage>,
) {
  // Provisioning (#75) is licensed — dark reads included: an unlicensed
  // deployment resolves no claim token and shows no org name.
  if (!isEntitled()) {
    return (
      <EnterpriseLockedCard
        feature="provisioning"
        description="Pre-provision member accounts and hand out claim links that bring teammates straight into your organization."
      />
    );
  }
  // Invoked as a function, not as `<ClaimPage />`: both are server
  // components, and composing them this way lets the unlicensed/licensed arms
  // be rendered in a test (JSX would hand the test harness an unresolved
  // async element). Keep it — the gate above is only proven while this is
  // renderable.
  return ClaimPage(props);
}
