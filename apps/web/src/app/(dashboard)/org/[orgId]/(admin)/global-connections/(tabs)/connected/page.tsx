import { Suspense } from "react";
import { GlobalConnectedPage } from "../../_components/global-connected-page";

export default function OrgConnectedPage() {
  return (
    <Suspense>
      <GlobalConnectedPage />
    </Suspense>
  );
}
