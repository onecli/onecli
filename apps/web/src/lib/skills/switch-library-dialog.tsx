"use client";

import { ArrowRight, Loader2 } from "lucide-react";
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
import { LibraryRef } from "./library-ref";

export interface SwitchLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  from: { repo: string; branch: string };
  to: { repo: string; branch: string };
  usage: LibraryUsage;
  busy: boolean;
  onConfirm: () => void;
}

/**
 * "Switch the skill library?": a switch to another repo or branch takes
 * every library skill off every agent (they belong to the old source), so it
 * is shown as what it is (old → new, and what is lost) and confirmed with a
 * button that names the cost.
 */
export const SwitchLibraryDialog = ({
  open,
  onOpenChange,
  from,
  to,
  usage,
  busy,
  onConfirm,
}: SwitchLibraryDialogProps) => {
  const skills = usage.skillNames.length;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch the skill library?</AlertDialogTitle>
          <AlertDialogDescription>
            Library skills come from one repo and branch. Agents using skills
            from the current one lose them. Their own skills stay.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-center gap-2 rounded-md border px-3 py-2">
          <LibraryRef {...from} />
          <ArrowRight
            className="text-muted-foreground size-4 shrink-0"
            aria-hidden
          />
          <span className="sr-only">to</span>
          <LibraryRef {...to} />
        </div>
        <LibraryImpact usage={usage} />
        <p className="text-muted-foreground text-xs">
          You can add skills from the new library to agents afterwards.
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            // Keep the dialog open across the request (Radix closes on click).
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy
              ? "Switching…"
              : `Switch and remove ${skills} skill${skills === 1 ? "" : "s"}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
