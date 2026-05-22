"use client";

import { useCounts } from "@/hooks/use-counts";
import { PageHeader } from "@dashboard/page-header";
import { ApiKeyCard } from "./api-key-card";
import { StatsCards } from "./stats-cards";
import { RecentActivityCard } from "./recent-activity-card";

export const OverviewContent = () => {
  const { data, isPending: loading } = useCounts();
  const resourceCounts = data ?? { agents: 0, apps: 0, llms: 0, secrets: 0 };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <PageHeader
        title="Overview"
        description="Your OneCLI dashboard at a glance."
      />
      <ApiKeyCard />
      <StatsCards
        agentCount={resourceCounts.agents}
        appCount={resourceCounts.apps}
        llmCount={resourceCounts.llms}
        secretCount={resourceCounts.secrets}
        loading={loading}
      />
      <RecentActivityCard />
    </div>
  );
};
