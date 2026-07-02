"use client";

import { useState } from "react";
import { HelpCircle } from "lucide-react";
import { Label } from "@onecli/ui/components/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";

export interface FieldLabelProps {
  htmlFor: string;
  label: string;
  /** Short instruction shown on hover (also the dialog body fallback). */
  short?: string;
  /** Detailed usage message shown when the help circle is clicked. */
  detail?: string;
}

/**
 * A field title with an optional circled "?" help affordance:
 * hover → the short instruction, click → a dialog with the detailed message.
 * The label text is explicitly selectable (the shadcn Label sets select-none,
 * which breaks "speak selected text" / copy for accessibility).
 */
export const FieldLabel = ({
  htmlFor,
  label,
  short,
  detail,
}: FieldLabelProps) => {
  const [open, setOpen] = useState(false);
  const hasHelp = !!short || !!detail;

  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor} className="select-text">
        {label}
      </Label>
      {hasHelp && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => detail && setOpen(true)}
                className="text-muted-foreground hover:text-foreground inline-flex shrink-0 rounded-full transition-colors"
                aria-label={`Help: ${label}`}
              >
                <HelpCircle className="size-3.5" />
              </button>
            </TooltipTrigger>
            {short && (
              <TooltipContent className="max-w-xs">{short}</TooltipContent>
            )}
          </Tooltip>
          {detail && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle className="select-text">{label}</DialogTitle>
                  <DialogDescription className="text-foreground/90 select-text text-sm leading-relaxed whitespace-pre-line">
                    {detail}
                  </DialogDescription>
                </DialogHeader>
              </DialogContent>
            </Dialog>
          )}
        </>
      )}
    </div>
  );
};
