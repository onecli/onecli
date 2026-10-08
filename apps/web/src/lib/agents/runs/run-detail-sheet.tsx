"use client";

import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@onecli/ui/components/sheet";
import { ScrollArea } from "@onecli/ui/components/scroll-area";
import { useRun } from "@/hooks/use-runs";
import { RunDetailBody } from "./run-detail-body";
import { RunMeta } from "./run-meta";

/**
 * A side panel with one run in full, opened by turn ID. Closed when
 * `turnId` is null; nothing is fetched until it opens.
 */
export const RunDetailSheet = ({
  agentId,
  turnId,
  onOpenChange,
}: {
  agentId: string;
  turnId: string | null;
  onOpenChange: (open: boolean) => void;
}) => {
  const detail = useRun(agentId, turnId);
  const run = detail.data?.run;

  return (
    <Sheet open={turnId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="pe-6 text-base">Run</SheetTitle>
          <SheetDescription asChild>
            {run ? <RunMeta run={run} /> : <span>Run details</span>}
          </SheetDescription>
        </SheetHeader>

        {detail.isError ? (
          <div
            role="alert"
            className="border-destructive/30 bg-destructive/5 text-destructive m-4 rounded-md border p-4 text-sm"
          >
            This run could not be loaded.
          </div>
        ) : run ? (
          <ScrollArea className="min-h-0 flex-1">
            <RunDetailBody run={run} />
          </ScrollArea>
        ) : (
          <div className="flex justify-center py-12">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
            <span className="sr-only">Loading run</span>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
};
