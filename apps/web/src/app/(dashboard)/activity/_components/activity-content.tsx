"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock3, Server, Timer, Zap } from "lucide-react";
import { useAuth } from "@/providers/auth-provider";
import {
  getRuntimeActivity,
  getRuntimeStats,
  type RuntimeActivityItem,
  type RuntimeStats,
} from "@/lib/actions/runtime-stats";
import { Badge } from "@onecli/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";

const formatTimestamp = (timestamp: Date) =>
  new Date(timestamp.getTime()).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const statusLabel = (item: RuntimeActivityItem) => {
  if (item.errorCode) return "error";
  if (item.statusCode === null) return "error";
  if (item.statusCode >= 400) return "error";
  return "success";
};

const statusVariant = (item: RuntimeActivityItem): "secondary" | "destructive" =>
  statusLabel(item) === "success" ? "secondary" : "destructive";

const emptyStats: RuntimeStats = {
  injections24h: 0,
  destinations24h: 0,
  activeAgents24h: 0,
  requests24h: 0,
  successRate24h: 0,
  avgLatencyMs24h: 0,
  p95LatencyMs24h: 0,
  lastActivityAt: null,
};

export const ActivityContent = () => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<RuntimeStats>(emptyStats);
  const [rows, setRows] = useState<RuntimeActivityItem[]>([]);

  const loadRuntimeData = useCallback(async () => {
    if (!user?.id) return;

    setLoading(true);
    try {
      const [runtimeStats, activityRows] = await Promise.all([
        getRuntimeStats(user.id),
        getRuntimeActivity(user.id, 100),
      ]);

      setStats(runtimeStats);
      setRows(activityRows);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    loadRuntimeData();
  }, [loadRuntimeData]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i} className="py-4">
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-28" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-7 w-14" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="py-4 gap-3">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Requests (24h)</CardTitle>
            <Server className="text-muted-foreground size-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.requests24h}</div>
          </CardContent>
        </Card>

        <Card className="py-4 gap-3">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Injections (24h)</CardTitle>
            <Zap className="text-muted-foreground size-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.injections24h}</div>
          </CardContent>
        </Card>

        <Card className="py-4 gap-3">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Avg Latency</CardTitle>
            <Timer className="text-muted-foreground size-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {Math.round(stats.avgLatencyMs24h)}ms
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              p95 {Math.round(stats.p95LatencyMs24h)}ms
            </p>
          </CardContent>
        </Card>

        <Card className="py-4 gap-3">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Last Activity</CardTitle>
            <Clock3 className="text-muted-foreground size-4" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-semibold">
              {stats.lastActivityAt ? formatTimestamp(stats.lastActivityAt) : "No events"}
            </div>
          </CardContent>
        </Card>
      </div>

      {rows.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm font-medium">No runtime events in the last 24 hours</p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            Generate traffic through the gateway to populate runtime telemetry.
          </p>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Recent Runtime Events</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Injections</TableHead>
                  <TableHead>Latency</TableHead>
                  <TableHead>Cache</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{formatTimestamp(item.createdAt)}</TableCell>
                    <TableCell>{item.agentName}</TableCell>
                    <TableCell>{item.host}</TableCell>
                    <TableCell className="max-w-xs truncate">{item.path}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(item)}>
                        {statusLabel(item)}
                        {item.statusCode ? ` (${item.statusCode})` : ""}
                      </Badge>
                    </TableCell>
                    <TableCell>{item.injectionCount}</TableCell>
                    <TableCell>{item.durationMs}ms</TableCell>
                    <TableCell>{item.cacheHit ? "hit" : "miss"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
