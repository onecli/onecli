"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { StatusBadge } from "@/app/(dashboard)/activity/_components/status-badge";
import { MethodBadge } from "@/app/(dashboard)/activity/_components/method-badge";
import { ProviderIcon } from "@/app/(dashboard)/activity/_components/provider-icon";
import { getRecentActivity } from "@/lib/actions/request-logs";
import { formatRelative } from "@/lib/format";
import { withProjectPrefix } from "@/lib/navigation";
import {
  isBlockedRequest,
  isRateLimitedRequest,
  type RequestLogEntry,
} from "@/lib/services/request-log-service";

export const RecentActivityCard = () => {
  const pathname = usePathname();
  const [logs, setLogs] = useState<RequestLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getRecentActivity()
      .then(setLogs)
      .finally(() => setLoading(false));
  }, []);

  const activityUrl = withProjectPrefix(pathname, "/activity");

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>Recent Activity</CardTitle>
          <p className="text-muted-foreground text-sm">
            Latest requests from your gateway.
          </p>
        </div>
        <Link
          href={activityUrl}
          className="text-muted-foreground hover:text-foreground group flex items-center gap-1 text-sm transition-colors"
        >
          View all
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-3.5 w-14" />
                <Skeleton className="h-5 w-10 rounded-full" />
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="ml-auto h-5 w-10 rounded-full" />
              </div>
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="text-muted-foreground py-6 text-center text-sm">
            No requests yet. Requests proxied through your gateway will appear
            here.
          </div>
        ) : (
          <div className="divide-y">
            {logs.map((log) => (
              <div
                key={log.id}
                className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <span className="text-muted-foreground text-xs tabular-nums w-14 shrink-0">
                  {formatRelative(log.createdAt)}
                </span>
                <MethodBadge method={log.method} />
                <div className="flex min-w-0 items-center gap-1.5 flex-1">
                  <ProviderIcon provider={log.provider} size={14} />
                  <span className="shrink-0 text-sm font-medium">
                    {log.host}
                  </span>
                  <span className="text-muted-foreground truncate font-mono text-xs">
                    {log.path}
                  </span>
                </div>
                <StatusBadge
                  status={log.status}
                  blocked={isBlockedRequest(log)}
                  rateLimited={isRateLimitedRequest(log)}
                />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
