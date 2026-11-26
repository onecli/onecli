import { Suspense } from "react";
import type { Metadata } from "next";
import { AgentActivitySection } from "./_components/agent-activity-section";

export const metadata: Metadata = {
  title: "Activity",
};

/** Runs and Traffic for one agent. The tab and filters live in the URL
 *  (useSearchParams), hence the boundary. */
export default function AgentActivityPage() {
  return (
    <Suspense>
      <AgentActivitySection />
    </Suspense>
  );
}
