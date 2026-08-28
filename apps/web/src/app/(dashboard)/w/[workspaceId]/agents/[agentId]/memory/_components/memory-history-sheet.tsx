"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@onecli/ui/components/sheet";
import { ScrollArea } from "@onecli/ui/components/scroll-area";
import { formatRelative } from "@onecli/api/lib/format";
import {
  useMemoryRevision,
  useMemoryRevisions,
  useRedactRevision,
  useRestoreRevision,
} from "@/hooks/use-memories";
import type { AgentMemorySummary, MemoryRevision } from "@/lib/api";
import { ChatMarkdown } from "../../chat/_components/chat-markdown";

/**
 * A memory's history: every version as written, newest first. Restore copies
 * an old snapshot forward (history shows the restore happened); redact
 * permanently blacks out one old version's text — the one history rewrite,
 * behind a destructive confirm, and never the latest (the current content is
 * edited or deleted instead, so a leak can't stay live).
 *
 * Snapshots render through ChatMarkdown ONLY — memory is durable,
 * agent-authored, untrusted text; a second renderer is a second place to
 * forget that posture.
 */
export interface MemoryHistorySheetProps {
  agentId: string;
  /** Null = closed. */
  memory: AgentMemorySummary | null;
  onOpenChange: (open: boolean) => void;
}

const authorLabel = (revision: MemoryRevision): string => {
  if (revision.authorKind === "agent") {
    return revision.authorEmail
      ? `Agent, for ${revision.authorEmail}`
      : "Agent";
  }
  return revision.authorEmail ?? "Someone";
};

export const MemoryHistorySheet = ({
  agentId,
  memory,
  onOpenChange,
}: MemoryHistorySheetProps) => {
  const view = useMemoryRevisions(agentId, memory?.id ?? null);
  const restore = useRestoreRevision(agentId);
  const redact = useRedactRevision(agentId);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [confirmRedact, setConfirmRedact] = useState<MemoryRevision | null>(
    null,
  );

  const revisions = view.data?.revisions ?? [];
  const latestSeq = revisions[0]?.seq ?? null;
  const selected =
    revisions.find((revision) => revision.seq === selectedSeq) ??
    revisions[0] ??
    null;

  // List rows carry PREVIEWS (at the 100k content cap a full list would be
  // megabytes); a clipped selection fetches its full body on demand.
  const needsFull =
    selected !== null && selected.contentTruncated && !selected.redactedAt;
  const fullRevision = useMemoryRevision(
    agentId,
    memory?.id ?? null,
    needsFull && selected ? selected.id : null,
  );
  const selectedContent = needsFull
    ? (fullRevision.data?.content ?? null)
    : (selected?.content ?? null);

  const busy = restore.isPending || redact.isPending;

  return (
    <Sheet open={memory !== null} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>History · {memory?.title ?? memory?.key}</SheetTitle>
          <SheetDescription>
            Every version as it was written, newest first.
          </SheetDescription>
        </SheetHeader>

        {view.isPending && memory !== null ? (
          <div className="flex justify-center py-12">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
            <span className="sr-only">Loading history</span>
          </div>
        ) : view.isError ? (
          // The apps-tab law again: no restore/redact buttons over a failed
          // load.
          <div
            role="alert"
            className="border-destructive/30 bg-destructive/5 text-destructive m-4 rounded-md border p-4 text-sm"
          >
            History failed to load. Refresh to try again.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="max-h-48 shrink-0 overflow-y-auto border-b">
              {revisions.map((revision) => (
                <button
                  key={revision.id}
                  type="button"
                  onClick={() => setSelectedSeq(revision.seq)}
                  className={`hover:bg-muted/50 flex w-full items-center gap-2 px-4 py-2 text-left text-sm ${
                    selected?.seq === revision.seq ? "bg-muted/50" : ""
                  }`}
                >
                  <span className="font-mono text-xs">#{revision.seq}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {authorLabel(revision)}
                  </span>
                  {revision.op === "restore" && (
                    <Badge variant="outline">
                      restored #{revision.restoredFromSeq}
                    </Badge>
                  )}
                  {revision.redactedAt && (
                    <Badge variant="destructive">redacted</Badge>
                  )}
                  {revision.seq === latestSeq && (
                    <Badge variant="secondary">current</Badge>
                  )}
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {formatRelative(revision.createdAt)}
                  </span>
                </button>
              ))}
            </div>

            {selected && (
              <>
                <ScrollArea className="min-h-0 flex-1 px-4 py-3">
                  {selected.redactedAt ? (
                    <p className="text-muted-foreground text-sm italic">
                      This version was redacted
                      {selected.redactedAt &&
                        ` ${formatRelative(selected.redactedAt)}`}
                      . Its text is permanently gone.
                    </p>
                  ) : (
                    <div className="text-sm">
                      {selected.title && (
                        <p className="mb-1 font-medium">{selected.title}</p>
                      )}
                      {selected.description && (
                        <p className="text-muted-foreground mb-2">
                          {selected.description}
                        </p>
                      )}
                      {needsFull && fullRevision.isError ? (
                        <p className="text-destructive text-sm">
                          This version&apos;s full text failed to load. Close
                          and reopen history to retry.
                        </p>
                      ) : selectedContent === null ? (
                        <div className="flex justify-center py-6">
                          <Loader2 className="text-muted-foreground size-4 animate-spin" />
                          <span className="sr-only">Loading full version</span>
                        </div>
                      ) : (
                        <ChatMarkdown text={selectedContent} />
                      )}
                    </div>
                  )}
                </ScrollArea>
                <div className="flex justify-end gap-2 border-t p-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      busy ||
                      selected.seq === latestSeq ||
                      selected.redactedAt !== null
                    }
                    loading={restore.isPending}
                    onClick={() =>
                      memory &&
                      restore.mutate(
                        { memoryId: memory.id, revisionId: selected.id },
                        {
                          onSuccess: () => toast.success("Version restored"),
                          onError: (error) =>
                            toast.error(String(error.message)),
                        },
                      )
                    }
                  >
                    Restore this version
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={
                      busy ||
                      selected.seq === latestSeq ||
                      selected.redactedAt !== null
                    }
                    onClick={() => setConfirmRedact(selected)}
                  >
                    Redact
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        <Dialog
          open={confirmRedact !== null}
          onOpenChange={(open) => {
            if (!open) setConfirmRedact(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Redact version #{confirmRedact?.seq}?</DialogTitle>
              <DialogDescription>
                Its saved text is permanently blacked out, for when something
                sensitive was stored. Who wrote it and when stays; the
                memory&apos;s current content is not affected.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                disabled={redact.isPending}
                onClick={() => setConfirmRedact(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={redact.isPending}
                onClick={() =>
                  memory &&
                  confirmRedact &&
                  redact.mutate(
                    { memoryId: memory.id, revisionId: confirmRedact.id },
                    {
                      onSuccess: () => {
                        toast.success("Version redacted");
                        setConfirmRedact(null);
                      },
                      onError: (error) => toast.error(String(error.message)),
                    },
                  )
                }
              >
                Redact
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
};
