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

// Lazy: the rows are the agent page's whole connection editor (its Manage
// sheet included), needed only in the moment right after a create, so the
// agents list never ships it up front.
const AppsSection = dynamic(() =>
  import("../[agentId]/_components/apps-section").then((m) => m.AppsSection),
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
 * user picks what it gets. The rows ARE the agent page's own (its Apps
 * section, Manage sheet included, and its Custom tab), unfolded because every
 * row starts off here and IS the choice. Each switch applies at once, so
 * there is nothing to submit: Done (or Esc) just closes.
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
      <DialogContent className="gap-0 p-0 sm:max-w-2xl">
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
            {/* Native max-height scroller so a long list keeps the footer in
                reach. */}
            <div className="max-h-[min(26rem,55vh)] overflow-y-auto overscroll-contain py-2">
              {tab === "apps" ? (
                <AppsSection agentId={agent.id} foldInactive={false} />
              ) : (
                <SecretGrantsTab
                  agentId={agent.id}
                  kind="secret"
                  foldInactive={false}
                />
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
