import { Suspense } from "react";
import { ActivityContent } from "./_components/activity-content";

export default function ActivityPage() {
  // The tab and filters live in the URL (useSearchParams).
  return (
    <Suspense>
      <ActivityContent />
    </Suspense>
  );
}
