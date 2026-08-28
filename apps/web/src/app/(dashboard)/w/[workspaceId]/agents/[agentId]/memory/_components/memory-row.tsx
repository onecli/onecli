"use client";

import { History, Pencil } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { formatRelative } from "@onecli/api/lib/format";
import type { AgentMemorySummary } from "@/lib/api";

export interface MemoryRowProps {
  memory: AgentMemorySummary;
  onEdit: () => void;
  onHistory: () => void;
}

export const MemoryRow = ({ memory, onEdit, onHistory }: MemoryRowProps) => (
  <div className="flex items-center gap-3 p-3">
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-sm font-medium">
          {memory.title ?? memory.key}
        </span>
        {memory.title && (
          <span className="text-muted-foreground truncate font-mono text-xs">
            {memory.key}
          </span>
        )}
      </div>
      <p className="text-muted-foreground mt-0.5 truncate text-sm">
        {memory.description ?? "No description"}
      </p>
      <p className="text-muted-foreground/80 mt-0.5 text-xs">
        Updated {formatRelative(memory.updatedAt)}
        {memory.lastRevisionSeq > 1 && ` · ${memory.lastRevisionSeq} versions`}
      </p>
    </div>
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={`History of ${memory.key}`}
      onClick={onHistory}
    >
      <History className="size-4" />
    </Button>
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={`Edit ${memory.key}`}
      onClick={onEdit}
    >
      <Pencil className="size-4" />
    </Button>
  </div>
);
