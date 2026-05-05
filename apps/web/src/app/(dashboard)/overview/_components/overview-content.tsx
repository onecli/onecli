"use client";

import { useEffect, useState } from "react";
import { getGatewayCounts } from "@/lib/actions/counts";
import { PageHeader } from "@dashboard/page-header";
import { ApiKeyCard } from "./api-key-card";
import { StatsCards } from "./stats-cards";

export const OverviewContent = () => {
  const [gatewayCounts, setGatewayCounts] = useState({
    agents: 0,
    secrets: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getGatewayCounts().then((counts) => {
      setGatewayCounts(counts);
      setLoading(false);
    });
  }, []);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <PageHeader
        title="Overview"
        description="Your OneCLI dashboard at a glance."
      />
      <ApiKeyCard />
      <StatsCards
        agentCount={gatewayCounts.agents}
        secretCount={gatewayCounts.secrets}
        loading={loading}
      />
    </div>
  );
};
