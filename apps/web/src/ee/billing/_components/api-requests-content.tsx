"use client";

import type { ApiRequestsData } from "@/ee/billing/api-request-actions";

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

const formatNumber = (n: number) => n.toLocaleString("en-US");

const pct = (used: number, total: number) =>
  total > 0 ? Math.min((used / total) * 100, 100) : 0;

export const ApiRequestsContent = ({ data }: { data: ApiRequestsData }) => {
  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border p-5">
          <div className="flex items-baseline justify-between">
            <p className="text-muted-foreground text-sm font-medium">
              Requests this period
            </p>
            <p className="text-muted-foreground text-xs">
              {formatDate(data.periodStart)} – {formatDate(data.periodEnd)}
            </p>
          </div>
          <p className="text-foreground mt-2 text-3xl font-bold tabular-nums">
            {formatNumber(data.totalUsed)}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            total gateway requests
          </p>
        </div>

        <div className="rounded-xl border p-5">
          <div className="flex items-baseline justify-between">
            <p className="text-muted-foreground text-sm font-medium">
              Integration calls
            </p>
            <p className="text-muted-foreground text-xs">
              {formatDate(data.periodStart)} – {formatDate(data.periodEnd)}
            </p>
          </div>
          <p className="text-foreground mt-2 text-3xl font-bold tabular-nums">
            {formatNumber(data.totalInjections)}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            requests with credential injection
          </p>
        </div>
      </div>

      {/* Per-agent breakdown */}
      {data.perAgent.length > 0 && (
        <div className="rounded-xl border">
          <div className="border-b px-5 py-3">
            <div className="flex items-center">
              <p className="text-foreground flex-1 text-sm font-semibold">
                Usage by agent
              </p>
              <p className="text-muted-foreground w-24 text-right text-xs">
                Requests
              </p>
              <p className="text-muted-foreground w-28 text-right text-xs">
                Integration calls
              </p>
            </div>
          </div>
          <div className="divide-y">
            {data.perAgent.map((agent) => {
              const agentPct = pct(agent.requests, data.totalUsed || 1);
              return (
                <div
                  key={agent.agentId}
                  className="flex items-center gap-4 px-5 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground truncate text-sm font-medium">
                      {agent.agentName}
                    </p>
                  </div>
                  <div className="bg-muted h-1.5 w-16 overflow-hidden rounded-full">
                    <div
                      className="h-full rounded-full bg-brand"
                      style={{ width: `${agentPct}%` }}
                    />
                  </div>
                  <p className="text-muted-foreground w-24 text-right text-sm tabular-nums">
                    {formatNumber(agent.requests)}
                  </p>
                  <p className="text-foreground w-28 text-right text-sm font-medium tabular-nums">
                    {formatNumber(agent.injections)}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
