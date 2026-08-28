import AppAvailabilityPage from "@/ee/app-availability/app-availability-page";
import { isEntitled } from "@onecli/api/lib/entitlements";
import { EnterpriseLockedCard } from "@/lib/components/enterprise-locked-card";

export default function Page() {
  // The app availability allowlist (#29) is licensed — dark unlicensed.
  if (!isEntitled()) {
    return (
      <EnterpriseLockedCard
        feature="app_availability"
        description="Restrict which apps each workspace may connect, based on who has access to it."
      />
    );
  }
  return <AppAvailabilityPage />;
}
