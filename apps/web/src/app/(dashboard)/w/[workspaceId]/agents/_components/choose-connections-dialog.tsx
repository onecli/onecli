"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import {
  AnimatedTabs,
  AnimatedTabList,
  AnimatedTabTrigger,
} from "@onecli/ui/components/animated-tabs";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { useCounts } from "@/hooks/use-counts";

type Tab = "apps" | "custom";

// Lazy: the tabs are the agent page's own (as switch-only tiles here), needed
// only in the moment right after a create, so the agents list never ships
// them up front.
const AppsTab = dynamic(() =>
  import("../[agentId]/_components/apps-tab").then((m) => m.AppsTab),
);
const SecretGrantsTab = dynamic(() =>
  import("../[agentId]/_components/secret-grants-tab").then(
    (m) => m.SecretGrantsTab,
  ),
);

export interface ChooseConnectionsDialogProps {
  /** The agent just created; null keeps the dialog closed. */
  agent: { id: string; name: string } | null;
  /** Closing (Done, Esc): the caller goes on to the agent. */
  onClose: () => void;
}

/**
 * The step right after an agent is created: it starts with no connection and
 * no custom connection (only the LLM key it runs on), so this is where the
 * user picks what it gets. The tabs ARE the agent page's own Apps and Custom
 * tabs, in their chooser shape: every connection in view, A to Z, as a tile
 * whose switch is its only control. Each switch applies at once, so there is
 * nothing to submit: Done (or Esc) just closes.
 */
export const ChooseConnectionsDialog = ({
  agent,
  onClose,
}: ChooseConnectionsDialogProps) => {
  // Null until the user picks a tab: until then it opens where there is
  // something to choose (Custom when the workspace has no app), and closing
  // resets it so the next agent starts the same way.
  const [picked, setPicked] = useState<Tab | null>(null);
  const { data: counts } = useCounts();
  const tab: Tab =
    picked ??
    ((counts?.apps ?? 0) === 0 && (counts?.secrets ?? 0) > 0
      ? "custom"
      : "apps");
  const close = () => {
    setPicked(null);
    onClose();
  };

  return (
    <Dialog
      open={agent !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {/* Wider than the default dialog, for three-wide tiles. A wider
          `sm:`/`lg:` max-width replaces the dialog's own 1rem-per-side
          cap, so the width keeps that margin instead (else the window
          touches the screen edges just above each breakpoint). */}
      <DialogContent className="w-[calc(100%-2rem)] gap-0 p-0 sm:max-w-3xl lg:max-w-5xl">
        <DialogHeader className="min-w-0 p-6 pb-2">
          <DialogTitle className="break-words">
            Choose {agent?.name ?? "this agent"}&apos;s connections
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            A new agent starts with none of this workspace&apos;s connections.
            Turn on the ones it should use. Changes apply immediately, and you
            can change them anytime from the agent&apos;s Connections section.
          </DialogDescription>
        </DialogHeader>
        {agent && (
          // `min-w-0`: a grid item of DialogContent, so the widest row can't
          // size the column past the viewport on a phone.
          <div className="min-w-0 px-6">
            <AnimatedTabs
              value={tab}
              onValueChange={(value) =>
                setPicked(value === "custom" ? "custom" : "apps")
              }
            >
              <AnimatedTabList>
                <AnimatedTabTrigger value="apps">Apps</AnimatedTabTrigger>
                <AnimatedTabTrigger value="custom">Custom</AnimatedTabTrigger>
              </AnimatedTabList>
            </AnimatedTabs>
            {/* One fixed height for both tabs, so switching Apps and Custom
                never resizes the window. A bigger pool scrolls here while
                the title, tabs and Done stay put. */}
            <div className="h-[min(18rem,55vh)] overflow-y-auto overscroll-contain py-3">
              {tab === "apps" ? (
                <AppsTab agentId={agent.id} chooser />
              ) : (
                <SecretGrantsTab agentId={agent.id} kind="secret" chooser />
              )}
            </div>
          </div>
        )}
        <DialogFooter className="border-border/50 border-t px-6 py-4">
          <Button onClick={close}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
