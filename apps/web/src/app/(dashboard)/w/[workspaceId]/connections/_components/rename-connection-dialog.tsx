"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { useRenameConnection } from "@/hooks/use-connections";
import type { PageScope } from "@/lib/api";

export interface RenameConnectionDialogProps {
  connectionId: string;
  /** The name the field starts with each time the dialog opens. */
  initialLabel: string;
  /** Which connections endpoint owns the row (the org one is admin-only). */
  scope: PageScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Rename one connection. Shared by the account card on the Connections page
 * and the row menu on an agent's Connections page, so both write the label
 * the same way.
 */
export const RenameConnectionDialog = ({
  connectionId,
  initialLabel,
  scope,
  open,
  onOpenChange,
}: RenameConnectionDialogProps) => {
  const [value, setValue] = useState(initialLabel);
  const rename = useRenameConnection(scope);
  // The parent opens the dialog, which Radix never reports through
  // onOpenChange, so each open re-seeds the field here (React's "adjust
  // state on a prop change" pattern, no effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValue(initialLabel);
  }

  const save = () => {
    const label = value.trim();
    if (!label || rename.isPending) return;
    rename.mutate(
      { id: connectionId, label },
      {
        onSuccess: () => {
          toast.success("Connection renamed");
          onOpenChange(false);
        },
      },
    );
  };

  const inputId = `rename-${connectionId}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename connection</DialogTitle>
        </DialogHeader>
        <div className="grid gap-1.5 py-2">
          <Label htmlFor={inputId}>Label</Label>
          <Input
            id={inputId}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. work, personal…"
            className="font-mono text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button
            onClick={save}
            disabled={!value.trim() || rename.isPending}
            loading={rename.isPending}
            size="sm"
          >
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
