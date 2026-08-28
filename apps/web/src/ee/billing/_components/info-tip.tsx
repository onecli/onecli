"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@onecli/ui/components/tooltip";

const tips: Record<string, string> = {
  agent:
    "An agent is a unique identity for one AI actor (Claude, Cursor, a custom bot, etc.). Each plan includes a fixed number of agents, counted across all your workspaces; pricing never depends on how much they work.",
  workspace:
    "A workspace groups agents, secrets, policy rules, and OAuth app connections together. Use separate workspaces for different apps, environments, or teams.",
  sharedWorkspaces:
    "Multiple users can manage the same workspace together, sharing all connections, secrets, and policy rules as a team.",
};

export const InfoTip = ({ tipKey }: { tipKey: string }) => {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-brand focus-visible:ring-ring/50 ml-1 inline-flex items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2"
          aria-label={`What is ${tipKey}?`}
          onClick={() => setOpen((prev) => !prev)}
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-72">
        {tips[tipKey]}
      </TooltipContent>
    </Tooltip>
  );
};
