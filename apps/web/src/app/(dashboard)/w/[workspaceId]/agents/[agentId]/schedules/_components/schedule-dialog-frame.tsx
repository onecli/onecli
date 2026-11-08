"use client";

import type { ReactNode } from "react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";

/**
 * The one schedule dialog's frame, shared by every kind of schedule (a task
 * the agent runs, the agent's eval schedule): title and description, a body
 * that scrolls inside a fixed frame, and the footer (delete, cancel, save).
 * Each kind brings its own fields, the shared When (`ScheduleWhenField`),
 * and its extras under `ScheduleAdvanced`, as children.
 */
export const ScheduleDialogFrame = ({
  open,
  onOpenChange,
  title,
  description,
  children,
  onDelete,
  deleteLabel = "Delete",
  deleting = false,
  busy,
  saving,
  canSave,
  saveLabel,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** The kind's fields. */
  children: ReactNode;
  /** Shown when editing; absent on create. */
  onDelete?: () => void;
  deleteLabel?: string;
  deleting?: boolean;
  busy: boolean;
  saving: boolean;
  canSave: boolean;
  saveLabel: string;
  onSave: () => void;
}) => (
  <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
    {/* The FRAME is fixed and the fields scroll inside it: a task's prompt
        is a whole runbook in practice, and a dialog that grows with it would
        carry its own title and Save button off-screen. */}
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      {/* `-m-1 p-1` buys the scroll box a 4px gutter: a focus ring is a
          box-shadow, which adds nothing to scrollable overflow, so a ring on
          an edge field would otherwise be shaved off. */}
      <DialogBody className="-m-1 space-y-4 p-1">{children}</DialogBody>

      <DialogFooter className="gap-2 sm:justify-between">
        {onDelete ? (
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={busy}
            loading={deleting}
            onClick={onDelete}
          >
            {deleteLabel}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={busy || !canSave} loading={saving} onClick={onSave}>
            {saveLabel}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
