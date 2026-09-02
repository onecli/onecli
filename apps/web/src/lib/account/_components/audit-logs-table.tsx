"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Badge } from "@onecli/ui/components/badge";
import type { AuditLogEntry } from "../actions";

const formatAction = (action: string, service: string) => {
  const verb =
    {
      create: "Created",
      update: "Updated",
      delete: "Deleted",
      regenerate: "Regenerated",
      connect: "Connected",
      disconnect: "Disconnected",
    }[action] ?? action;

  const noun =
    {
      agent: "agent",
      secret: "secret",
      rule: "rule",
      "api-key": "API key",
      "app-connection": "app connection",
      "app-config": "app config",
      deployment: "deployment",
      workspace: "workspace",
    }[service] ?? service;

  return `${verb} ${noun}`;
};

const formatDate = (date: Date) => {
  const day = date.getDate();
  const month = date.toLocaleString("en-US", { month: "short" });
  const year = date.getFullYear();
  const time = date.toLocaleString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${day} ${month} ${year} ${time}`;
};

const formatUtc = (date: Date) => {
  const day = date.getUTCDate();
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const year = date.getUTCFullYear();
  const h = String(date.getUTCHours()).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${day} ${month} ${year} ${h}:${m}:${s}`;
};

const formatRelative = (date: Date) => {
  const diff = Date.now() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
};

const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const hasMetadata = (metadata: unknown): metadata is Record<string, unknown> =>
  metadata != null &&
  typeof metadata === "object" &&
  Object.keys(metadata as Record<string, unknown>).length > 0;

const DateTooltip = ({ date }: { date: Date }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className="text-muted-foreground cursor-pointer text-sm decoration-dotted underline-offset-4 hover:underline">
        {formatDate(date)}
      </span>
    </TooltipTrigger>
    <TooltipContent side="left" align="start" className="font-mono text-xs">
      <table className="border-separate border-spacing-x-3 border-spacing-y-0.5">
        <tbody>
          <tr>
            <td className="text-muted-foreground">UTC</td>
            <td>{formatUtc(date)}</td>
          </tr>
          <tr>
            <td className="text-muted-foreground">{localTz}</td>
            <td>{formatDate(date)}</td>
          </tr>
          <tr>
            <td className="text-muted-foreground">Relative</td>
            <td>{formatRelative(date)}</td>
          </tr>
          <tr>
            <td className="text-muted-foreground">Timestamp</td>
            <td>{date.toISOString()}</td>
          </tr>
        </tbody>
      </table>
    </TooltipContent>
  </Tooltip>
);

interface Props {
  logs: AuditLogEntry[];
}

export const AuditLogsTable = ({ logs }: Props) => {
  const router = useRouter();
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Viewing {logs.length} log{logs.length !== 1 ? "s" : ""} in total
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => router.refresh()}
        >
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Action</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="w-[100px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="text-muted-foreground py-8 text-center"
                >
                  No audit logs found.
                </TableCell>
              </TableRow>
            ) : (
              logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell
                    className="cursor-pointer"
                    onClick={() => setSelected(log)}
                  >
                    <span className="text-sm">
                      {formatAction(log.action, log.service)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">
                      {log.workspaceName ?? log.organizationName ?? "-"}
                    </span>
                    <span className="text-muted-foreground ml-1.5 text-xs">
                      {log.scope === "organization"
                        ? "(org)"
                        : `(${log.workspaceId ?? "workspace"})`}
                    </span>
                  </TableCell>
                  <TableCell
                    className="cursor-pointer"
                    onClick={() => setSelected(log)}
                  >
                    <DateTooltip date={log.createdAt} />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelected(log)}
                    >
                      View details
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!selected} onOpenChange={() => setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Audit Log Details</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Action</span>
                <span>{formatAction(selected.action, selected.service)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge
                  variant={
                    selected.status === "success" ? "default" : "destructive"
                  }
                >
                  {selected.status}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Source</span>
                <span>{selected.source}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">User</span>
                <span>{selected.userEmail}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Scope</span>
                <span>
                  {selected.workspaceName ?? selected.organizationName ?? "-"}
                  {selected.scope === "organization"
                    ? " (org)"
                    : ` (${selected.workspaceId ?? "workspace"})`}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Date</span>
                <span>{formatDate(selected.createdAt)}</span>
              </div>
              {hasMetadata(selected.metadata) && (
                <div className="space-y-1">
                  <span className="text-muted-foreground">Metadata</span>
                  <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                    {JSON.stringify(selected.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
