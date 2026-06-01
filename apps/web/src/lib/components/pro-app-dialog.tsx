"use client";

import { ExternalLink } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { AppIcon } from "@/app/(dashboard)/connections/_components/app-icon";

interface ProAppDialogProps {
  appName: string;
  appIcon: string;
  appDarkIcon?: string;
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const ProAppDialog = ({
  appName,
  appIcon,
  appDarkIcon,
  description,
  open,
  onOpenChange,
}: ProAppDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-sm">
        <div className="flex flex-col items-center px-8 pt-10 pb-8">
          <div className="flex size-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
            <AppIcon
              icon={appIcon}
              darkIcon={appDarkIcon}
              name={appName}
              size={28}
            />
          </div>

          <DialogHeader className="mt-4 items-center p-0">
            <DialogTitle className="text-lg">{appName}</DialogTitle>
          </DialogHeader>

          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-brand/20 bg-brand/5 px-2.5 py-0.5">
            <svg
              width="11"
              height="9"
              viewBox="0 0 44 36"
              fill="none"
              className="shrink-0 -mt-px"
            >
              <path
                d="M2 2L16 18L2 34"
                stroke="currentColor"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-brand"
              />
              <path
                d="M22 2L36 18L22 34"
                stroke="currentColor"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-brand"
              />
            </svg>
            <span className="text-[11px] font-semibold tracking-wide text-brand">
              Team
            </span>
          </div>

          <p className="mt-4 text-center text-sm leading-relaxed text-muted-foreground text-balance">
            {description}
          </p>
          <p className="mt-1.5 text-center text-xs text-muted-foreground/70 text-balance">
            Available on OneCLI Cloud and on-prem enterprise plans.
          </p>

          <div className="mt-6 flex w-full flex-col gap-2.5">
            <Button
              className="w-full"
              onClick={() =>
                window.open(
                  "https://app.onecli.sh",
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              Try OneCLI Cloud
              <ExternalLink className="size-3.5" />
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() =>
                window.open(
                  "https://cal.com/onecli",
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              Looking for on-prem? Talk to sales
              <ExternalLink className="size-3.5" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
