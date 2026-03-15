"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/providers/auth-provider";
import { getGatewayCounts } from "@/lib/actions/counts";
import { PageHeader } from "@dashboard/page-header";
import { ApiKeyCard } from "./api-key-card";
import { StatsCards } from "./stats-cards";

export const OverviewContent = () => {
  const { user } = useAuth();
  const [gatewayCounts, setGatewayCounts] = useState({
    agents: 0,
    secrets: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;

    setLoading(true);
    getGatewayCounts(user.id).then((counts) => {
      setGatewayCounts(counts);
      setLoading(false);
    });
  }, [user?.id]);

  return (
    <div className="flex flex-1 flex-col gap-6 max-w-5xl">
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
