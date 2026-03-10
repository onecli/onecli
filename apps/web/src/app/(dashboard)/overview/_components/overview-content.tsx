"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/providers/auth-provider";
import {
  getRecentAuditLogs,
  getAuditStats,
  getProxyCounts,
} from "@/lib/actions/audit";
import { DefaultAgentCard } from "./default-agent-card";
import { StatsCards } from "./stats-cards";
import { RecentAuditTable } from "./recent-audit-table";

interface AuditLogEntry {
  id: string;
  action: string;
  service: string;
  status: string;
  source: string;
  createdAt: Date;
}

interface AuditStats {
  totalActions: number;
  recentActions: number;
  serviceCount: number;
}

export function OverviewContent() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [proxyCounts, setProxyCounts] = useState({
    agents: 0,
    secrets: 0,
    policies: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;

    setLoading(true);
    Promise.all([
      getRecentAuditLogs(5, user.id),
      getAuditStats(user.id),
      getProxyCounts(user.id),
    ]).then(([logsData, statsData, proxy]) => {
      setLogs(logsData);
      setStats(statsData);
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

      <DefaultAgentCard />

      <StatsCards
        totalActions={stats?.totalActions ?? 0}
        recentActions={stats?.recentActions ?? 0}
        serviceCount={stats?.serviceCount ?? 0}
        agentCount={proxyCounts.agents}
        secretCount={proxyCounts.secrets}
        policyCount={proxyCounts.policies}
        loading={loading}
      />

      <RecentAuditTable logs={logs} />
    </div>
  );
}
