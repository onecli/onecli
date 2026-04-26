"use client";

import { Terminal } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { AppIcon } from "./app-icon";

interface ConnectAppDialogProps {
  appName: string;
  appIcon: string;
  appDarkIcon?: string;
  agentName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: () => void;
}

export const ConnectAppDialog = ({
  appName,
  appIcon,
  appDarkIcon,
  agentName,
  open,
  onOpenChange,
  onConnect,
}: ConnectAppDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-sm">
        <div className="flex flex-col items-center gap-5 px-8 pt-10 pb-6">
          {agentName ? (
            <div className="flex w-full items-center gap-2.5 rounded-lg border border-brand/20 bg-brand/5 px-3.5 py-2.5">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand/10">
                <Terminal aria-hidden="true" className="size-3.5 text-brand" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground line-clamp-1">
                  {agentName} is requesting access
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Your agent will retry automatically once connected.
                </p>
              </div>
            </div>
          ) : null}
          <div className="flex size-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
            <AppIcon
              icon={appIcon}
              darkIcon={appDarkIcon}
              name={appName}
              size={28}
            />
          </div>
          <div className="text-center">
            <DialogHeader className="items-center p-0">
              <DialogTitle className="text-lg">Connect {appName}</DialogTitle>
            </DialogHeader>
            <p className="text-muted-foreground mt-1 text-xs">
              You&apos;ll be redirected to authenticate.
            </p>
          </div>
          <Button className="w-full" onClick={onConnect}>
            Continue
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
