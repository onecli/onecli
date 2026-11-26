"use client";

import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import type { LibraryUsage } from "@/lib/api";
import { LibraryImpact } from "./library-impact";

export interface DisconnectLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repo: string;
  usage: LibraryUsage | null;
  busy: boolean;
  onConfirm: () => void;
}

/** "Disconnect the skill library?": what leaves agents, and that a later
 * reconnect starts clean (it does not bring these assignments back). */
export const DisconnectLibraryDialog = ({
  open,
  onOpenChange,
  repo,
  usage,
  busy,
  onConfirm,
}: DisconnectLibraryDialogProps) => {
  const inUse = usage && usage.skillNames.length > 0;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect the skill library?</AlertDialogTitle>
          <AlertDialogDescription>
            OneCLI stops reading{" "}
            <span className="text-foreground font-mono">{repo}</span>.{" "}
            {inUse
              ? "These library skills leave the agents using them. Reconnecting later doesn't bring them back."
              : "No agent uses a library skill yet."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {inUse && <LibraryImpact usage={usage} />}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? "Disconnecting…" : "Disconnect"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
