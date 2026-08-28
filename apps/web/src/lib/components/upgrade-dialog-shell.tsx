"use client";

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";

export interface UpgradeDialogShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A pre-styled icon node (lucide icon or <AppIcon/>) shown in the tile. */
  icon: ReactNode;
  title: string;
  /** Optional plan pill, e.g. "Team". */
  pill?: string;
  description: ReactNode;
  /** Optional body between the description and the footer (e.g. a usage bar). */
  children?: ReactNode;
  /** Action button(s); the shell handles top spacing and full width. */
  footer: ReactNode;
}

/**
 * The shared chrome for every upgrade/paywall modal: a centered icon tile,
 * title, optional plan pill, description, an optional body slot, and a footer.
 * Used by the feature paywall, the team-app upsell, and the quota dialog so
 * they all look identical.
 */
export const UpgradeDialogShell = ({
  open,
  onOpenChange,
  icon,
  title,
  pill,
  description,
  children,
  footer,
}: UpgradeDialogShellProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="gap-0 p-0 sm:max-w-sm">
      <div className="flex flex-col items-center px-8 pt-10 pb-8">
        <div className="bg-card flex size-14 items-center justify-center rounded-2xl border shadow-sm">
          {icon}
        </div>

        <DialogHeader className="mt-4 items-center p-0">
          <DialogTitle className="text-lg">{title}</DialogTitle>
        </DialogHeader>

        {pill ? (
          <span className="border-brand/20 bg-brand/5 text-brand mt-2 inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-wide">
            {pill}
          </span>
        ) : null}

        <DialogDescription className="text-muted-foreground mt-3 text-center text-sm leading-relaxed text-balance">
          {description}
        </DialogDescription>

        {children ? <div className="mt-4 w-full">{children}</div> : null}

        <div className="mt-6 w-full">{footer}</div>
      </div>
    </DialogContent>
  </Dialog>
);
