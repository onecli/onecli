"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/providers/auth-provider";
import { getProxyCounts } from "@/lib/actions/counts";
import { ApiKeyCard } from "./api-key-card";
import { StatsCards } from "./stats-cards";

export function OverviewContent() {
  const { user } = useAuth();
  const [proxyCounts, setProxyCounts] = useState({
    agents: 0,
    secrets: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;

    setLoading(true);
    getProxyCounts(user.id).then((proxy) => {
      setProxyCounts(proxy);
      setLoading(false);
    });
  }, [user?.id]);

  return (
    <div className="flex flex-1 flex-col gap-6 p-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-muted-foreground text-sm">
          Your OneCLI dashboard at a glance.
        </p>
      </div>

      <ApiKeyCard />

      <StatsCards
        agentCount={proxyCounts.agents}
        secretCount={proxyCounts.secrets}
        loading={loading}
      />
    </div>
  );
}
