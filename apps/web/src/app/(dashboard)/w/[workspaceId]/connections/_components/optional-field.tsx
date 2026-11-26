"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";

export interface OptionalFieldProps {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * A collapsed "<label> (optional)" toggle that reveals one field. Closed
 * means unset: the form ignores the field's value while it is closed, so
 * nothing hidden is ever saved.
 */
export const OptionalField = ({
  label,
  open,
  onOpenChange,
  children,
}: OptionalFieldProps) => (
  <Collapsible open={open} onOpenChange={onOpenChange} className="space-y-2">
    <CollapsibleTrigger className="group text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-sm text-xs transition-colors outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]">
      <ChevronRight
        aria-hidden
        className="size-3.5 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
      />
      {label} (optional)
    </CollapsibleTrigger>
    <CollapsibleContent className="space-y-2">{children}</CollapsibleContent>
  </Collapsible>
);
