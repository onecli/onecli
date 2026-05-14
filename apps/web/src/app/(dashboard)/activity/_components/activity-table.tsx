"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import { StatusBadge } from "./status-badge";
import { MethodBadge } from "./method-badge";
import { ProviderIcon } from "./provider-icon";
import { formatRelative, formatUTC } from "@onecli/api/lib/format";
import { getProviderIcon } from "@onecli/api/apps/provider-icons";
import {
  isBlockedRequest,
  isRateLimitedRequest,
  type RequestLogEntry,
} from "@onecli/api/services/request-log-service";

const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const DateCell = ({ dateStr }: { dateStr: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className="text-muted-foreground cursor-default text-xs tabular-nums">
        {formatRelative(dateStr)}
      </span>
    </TooltipTrigger>
    <TooltipContent side="left" align="start" className="font-mono text-xs">
      <table className="border-separate border-spacing-x-3 border-spacing-y-0.5">
        <tbody>
          <tr>
            <td className="text-muted-foreground">UTC</td>
            <td>{formatUTC(dateStr)}</td>
          </tr>
          <tr>
            <td className="text-muted-foreground">{localTz}</td>
            <td>{new Date(dateStr).toLocaleString()}</td>
          </tr>
          <tr>
            <td className="text-muted-foreground">ISO</td>
            <td>{dateStr}</td>
          </tr>
        </tbody>
      </table>
    </TooltipContent>
  </Tooltip>
);

interface ActivityTableProps {
  logs: RequestLogEntry[];
  onRowClick: (log: RequestLogEntry) => void;
}

export const ActivityTable = ({ logs, onRowClick }: ActivityTableProps) => (
  <div className="rounded-lg border overflow-hidden">
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[5.5rem]">Time</TableHead>
          <TableHead className="w-[7rem]">Agent</TableHead>
          <TableHead className="w-[4.5rem]">Method</TableHead>
          <TableHead className="max-w-[18rem]">Endpoint</TableHead>
          <TableHead className="w-[12rem]">Provider</TableHead>
          <TableHead className="w-[7rem]">Status</TableHead>
          <TableHead className="w-[5rem] text-right">Latency</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {logs.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell
              colSpan={7}
              className="text-muted-foreground py-16 text-center text-sm"
            >
              No requests yet.
            </TableCell>
          </TableRow>
        ) : (
          logs.map((log) => {
            const providerInfo = getProviderIcon(log.provider);
            return (
              <TableRow
                key={log.id}
                className="cursor-pointer"
                onClick={() => onRowClick(log)}
              >
                <TableCell>
                  <DateCell dateStr={log.createdAt} />
                </TableCell>
                <TableCell>
                  <span className="text-sm truncate block max-w-[7rem]">
                    {log.agentName ?? (
                      <span className="text-muted-foreground font-mono text-xs">
                        {log.agentId.slice(0, 8)}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <MethodBadge method={log.method} />
                </TableCell>
                <TableCell className="max-w-[18rem]">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      {log.host.replace(/:(?:443|80)$/, "")}
                    </div>
                    <div className="text-muted-foreground truncate font-mono text-xs">
                      {log.path || "/"}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="shrink-0">
                          <ProviderIcon provider={log.provider} size={14} />
                        </span>
                        <span className="text-sm truncate">
                          {providerInfo?.name ?? log.provider}
                        </span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {providerInfo?.name ?? log.provider}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <StatusBadge
                    status={log.status}
                    blocked={isBlockedRequest(log)}
                    rateLimited={isRateLimitedRequest(log)}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    {log.latencyMs}ms
                  </span>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  </div>
);
