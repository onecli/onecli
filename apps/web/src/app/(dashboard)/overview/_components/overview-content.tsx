"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/providers/auth-provider";
import { getGatewayCounts } from "@/lib/actions/counts";
import { getRuntimeStats } from "@/lib/actions/runtime-stats";
import { PageHeader } from "@dashboard/page-header";
import { ApiKeyCard } from "./api-key-card";
import { StatsCards } from "./stats-cards";

export const OverviewContent = () => {
  const { user } = useAuth();
  const [gatewayCounts, setGatewayCounts] = useState({
    agents: 0,
    secrets: 0,
  });
  const [runtimeStats, setRuntimeStats] = useState({
    injections24h: 0,
    destinations24h: 0,
    activeAgents24h: 0,
    requests24h: 0,
    successRate24h: 0,
    avgLatencyMs24h: 0,
    p95LatencyMs24h: 0,
    lastActivityAt: null as Date | null,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;

    setLoading(true);
    Promise.all([getGatewayCounts(user.id), getRuntimeStats(user.id)])
      .then(([counts, stats]) => {
        setGatewayCounts(counts);
        setRuntimeStats(stats);
      })
      .finally(() => {
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
        injections24h={runtimeStats.injections24h}
        destinations24h={runtimeStats.destinations24h}
        activeAgents24h={runtimeStats.activeAgents24h}
        successRate24h={runtimeStats.successRate24h}
        p95LatencyMs24h={runtimeStats.p95LatencyMs24h}
        loading={loading}
      />
    </div>
  );
};
