"use client";

import { Lock } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import type { RunListItem } from "@/lib/api";
import { runAskedBy, runDuration } from "@/lib/agents/runs/run-format";
import { RunSourceBadge } from "@/lib/agents/runs/run-source-badge";
import { RunStatusBadge } from "@/lib/agents/runs/run-status-badge";
import { ProviderLabel } from "./provider-label";
import { TimeCell } from "./time-cell";

/** Activity's Runs table, shaped like the Network table: one row per run.
 *  A colleague's private run shows only its facts; opening it is the
 *  (audited) read. */
export const RunsTable = ({
  runs,
  showApps,
  onOpen,
  emptyMessage,
}: {
  runs: RunListItem[];
  /** Gateway app evidence is admin-only; without it the column says nothing. */
  showApps: boolean;
  onOpen: (run: RunListItem) => void;
  emptyMessage: string;
}) => (
  <div className="overflow-hidden rounded-lg border">
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[5.5rem]">Time</TableHead>
          <TableHead className="w-[7rem]">Agent</TableHead>
          <TableHead className="w-[6rem]">Source</TableHead>
          <TableHead>Question</TableHead>
          <TableHead className="w-[10rem]">Asked by</TableHead>
          {showApps && <TableHead className="w-[10rem]">Apps</TableHead>}
          <TableHead className="w-[5rem]">Status</TableHead>
          <TableHead className="w-[5rem] text-right">Duration</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell
              colSpan={showApps ? 8 : 7}
              className="text-muted-foreground py-16 text-center text-sm"
            >
              {emptyMessage}
            </TableCell>
          </TableRow>
        ) : (
          runs.map((run) => (
            <TableRow
              key={run.turnId}
              tabIndex={0}
              className="focus-visible:ring-ring cursor-pointer focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
              onClick={() => onOpen(run)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(run);
                }
              }}
            >
              <TableCell>
                <TimeCell iso={run.createdAt} />
              </TableCell>
              <TableCell>
                <span className="block max-w-[7rem] truncate text-sm">
                  {run.agent.name}
                </span>
              </TableCell>
              <TableCell>
                <RunSourceBadge source={run.source} />
              </TableCell>
              <TableCell className="max-w-[22rem]">
                {run.private ? (
                  <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm italic">
                    <Lock className="size-3.5 shrink-0" aria-hidden />
                    Private chat. Open to read it.
                  </span>
                ) : (
                  <>
                    <div className="truncate text-sm font-medium">
                      {run.question || "(no text)"}
                    </div>
                    {run.toolNames.length > 0 && (
                      <div className="text-muted-foreground truncate text-xs">
                        {run.toolNames.length}{" "}
                        {run.toolNames.length === 1 ? "tool" : "tools"}
                      </div>
                    )}
                  </>
                )}
              </TableCell>
              <TableCell>
                <span className="block max-w-[10rem] truncate text-sm">
                  {runAskedBy(run.askedBy)}
                </span>
              </TableCell>
              {showApps && (
                <TableCell>
                  <div className="flex flex-col gap-1">
                    {run.appsUsed.map((app) => (
                      <ProviderLabel key={app} provider={app} />
                    ))}
                  </div>
                </TableCell>
              )}
              <TableCell>
                {run.status === "done" ? (
                  <span className="text-muted-foreground text-xs">Done</span>
                ) : (
                  <RunStatusBadge status={run.status} />
                )}
              </TableCell>
              <TableCell className="text-right">
                <span className="text-muted-foreground font-mono text-xs tabular-nums">
                  {runDuration(run.durationMs)}
                </span>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  </div>
);
