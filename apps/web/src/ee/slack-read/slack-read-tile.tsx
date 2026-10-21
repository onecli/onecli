"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { AppIcon } from "@/lib/components/app-icon";
import { SlackReadAgentsDialog } from "./slack-read-agents-dialog";

/**
 * The Slack tile on the workspace Connections page (licensed). Same face as
 * the app tiles beside it, but it opens the agent finder instead of a
 * connect popup: a Slack read connection lives on each agent, not here.
 */
export const SlackReadTile = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group bg-card hover:bg-accent/50 flex w-full items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors"
      >
        <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg dark:border-white/10 dark:bg-white/10">
          <AppIcon icon="/icons/slack.svg" name="Slack" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Slack</span>
          <span className="text-muted-foreground group-hover:text-foreground block text-[11px] transition-colors">
            Let an agent read your channels
          </span>
        </span>
        <ChevronRight
          className="text-muted-foreground group-hover:text-foreground size-4 transition-all group-hover:translate-x-0.5"
          aria-hidden
        />
      </button>
      <SlackReadAgentsDialog open={open} onOpenChange={setOpen} />
    </>
  );
};
