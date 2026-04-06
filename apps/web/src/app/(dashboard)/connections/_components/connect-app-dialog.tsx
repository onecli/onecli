"use client";

import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { AppIcon } from "./app-icon";

interface ConnectAppDialogProps {
  provider: string;
  appName: string;
  appIcon: string;
  appDarkIcon?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: () => void;
}

export const ConnectAppDialog = ({
  appName,
  appIcon,
  appDarkIcon,
  open,
  onOpenChange,
  onConnect,
}: ConnectAppDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-sm">
        <div className="flex flex-col items-center gap-5 px-8 pt-10 pb-6">
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
