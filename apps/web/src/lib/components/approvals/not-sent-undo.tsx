"use client";

import { Button } from "@onecli/ui/components/button";

/** A declined card, collapsed: "Not sent · Undo". */
export const NotSentUndo = ({ onUndo }: { onUndo: () => void }) => (
  <div className="text-muted-foreground flex items-center gap-1 px-4 py-2 text-xs">
    <span>Not sent</span>
    <span aria-hidden>·</span>
    <Button variant="link" size="xs" className="h-auto p-0" onClick={onUndo}>
      Undo
    </Button>
  </div>
);
