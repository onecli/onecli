import { Suspense } from "react";
import { GlobalAppsPage } from "../_components/global-apps-page";

export default function OrgConnectionsPage() {
  return (
    <Suspense>
      <GlobalAppsPage />
    </Suspense>
  );
}
