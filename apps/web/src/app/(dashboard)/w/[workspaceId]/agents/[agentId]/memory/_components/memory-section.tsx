"use client";

import { useState } from "react";
import { Brain, Loader2, Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { useMemories } from "@/hooks/use-memories";
import type { AgentMemorySummary } from "@/lib/api";
import { MemoryRow } from "./memory-row";
import { MemoryDialog } from "./memory-dialog";
import { MemoryHistorySheet } from "./memory-history-sheet";

/**
 * The agent's Memory section (step 8; files writable since the write-back
 * amendment): what it has saved, correctable in place. The agent writes
 * through its memory tools or by editing its memory/ files — both land
 * here; humans read, edit, restore, and redact — the DB is the one truth
 * for everyone.
 */
export const MemorySection = () => {
  const agent = useAgentPageAgent();
  const view = useMemories(agent.id);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AgentMemorySummary | null>(null);
  const [history, setHistory] = useState<AgentMemorySummary | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (memory: AgentMemorySummary) => {
    setEditing(memory);
    setDialogOpen(true);
  };

  if (view.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
        <span className="sr-only">Loading memory</span>
      </div>
    );
  }

  // Never render mutating controls over a failed load — a blind edit would
  // write against invisible state (the apps-tab law).
  if (view.isError) {
    return (
      <div
        role="alert"
        className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-4 text-sm"
      >
        Memory failed to load. Refresh to try again.
      </div>
    );
  }

  const rows = view.data.memories;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Memory</h2>
          <p className="text-muted-foreground text-sm">
            What this agent has learned and saved. It writes here through its
            memory tools and by editing its memory files; your edits are live
            from its next read.
          </p>
        </div>
        {rows.length > 0 && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            New memory
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <div className="bg-muted flex size-10 items-center justify-center rounded-full">
            <Brain className="text-muted-foreground size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">Nothing remembered yet</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Teach it in chat (“remember that our staging URL is …”) or add one
              here yourself.
            </p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            New memory
          </Button>
        </Card>
      ) : (
        <div className="divide-y rounded-md border">
          {rows.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              onEdit={() => openEdit(memory)}
              onHistory={() => setHistory(memory)}
            />
          ))}
        </div>
      )}

      <MemoryDialog
        agentId={agent.id}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
      />
      <MemoryHistorySheet
        agentId={agent.id}
        memory={history}
        onOpenChange={(open) => {
          if (!open) setHistory(null);
        }}
      />
    </div>
  );
};
