"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";
import { cn } from "@onecli/ui/lib/utils";

/** The settings most schedules never touch (timezone, a kind's extras),
 * folded away so the dialog opens on name, task and when. The summary
 * says what is inside, so nothing is hidden without a trace. */
export const ScheduleAdvanced = ({
  summary,
  defaultOpen = false,
  children,
}: {
  summary: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center gap-1.5 rounded-sm text-sm outline-none focus-visible:ring-2">
        <ChevronDown
          className={cn("size-4 transition-transform", !open && "-rotate-90")}
          aria-hidden
        />
        <span className="font-medium">Advanced</span>
        {!open && <span className="truncate text-xs">· {summary}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
};
