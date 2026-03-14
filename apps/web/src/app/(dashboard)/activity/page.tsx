import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { ActivityContent } from "./_components/activity-content";

export const metadata: Metadata = {
  title: "Activity",
};

export default function ActivityPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 max-w-6xl">
      <PageHeader
        title="Runtime Activity"
        description="Last 24 hours of gateway injections, destinations, and client activity."
      />
      <ActivityContent />
    </div>
  );
}
