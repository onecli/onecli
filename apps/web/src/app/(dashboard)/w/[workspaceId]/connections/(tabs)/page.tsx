import { Suspense } from "react";
import { AppsTab } from "../_components/apps-tab";

export default function ConnectionsPage() {
  return (
    <Suspense>
      <AppsTab />
    </Suspense>
  );
}
