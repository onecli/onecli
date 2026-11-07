"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import type { LibraryUsage, SkillSource } from "@/lib/api";
import { ConnectLibraryForm } from "./connect-library-form";

export interface ConnectLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: SkillSource | null;
  usage: LibraryUsage | null;
  /** "Install GitHub for skills only" is available on this deployment. */
  skillsOnlyInstall: boolean;
}

export const ConnectLibraryDialog = ({
  open,
  onOpenChange,
  current,
  usage,
  skillsOnlyInstall,
}: ConnectLibraryDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {current?.accessLost
            ? "Reconnect the skill library"
            : current
              ? "Change skills repo"
              : "Connect a skills repo"}
        </DialogTitle>
        <DialogDescription>
          {current?.accessLost
            ? "OneCLI can no longer read this repo. Pick GitHub access that can. "
            : ""}
          OneCLI reads the repo and keeps the skills agents add in sync with it.
          It never writes to it.
        </DialogDescription>
      </DialogHeader>
      {open && (
        <ConnectLibraryForm
          current={current}
          usage={usage}
          skillsOnlyInstall={skillsOnlyInstall}
          onDone={() => onOpenChange(false)}
        />
      )}
    </DialogContent>
  </Dialog>
);
