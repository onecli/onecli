"use client";

import { useState } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import {
  AnimatedTabs,
  AnimatedTabList,
  AnimatedTabTrigger,
} from "@onecli/ui/components/animated-tabs";
import { Badge } from "@onecli/ui/components/badge";
import { useCounts } from "@/hooks/use-counts";
import { AppsSection } from "./apps-section";
import { SecretGrantsTab } from "./secret-grants-tab";
import { AddConnectionButton } from "./add-connection-button";

/**
 * The agent's Connections section (§3.18 as amended): what this agent can
 * reach, in ONE place. Apps and custom secrets used to be two rail entries
 * asking the same question of the same agent — they are the two TABS here,
 * mirroring the workspace-level Connections page so the vocabulary is the same
 * at both levels. Models are deliberately NOT here: what an agent runs on is
 * not something it reaches, and it keeps its own rail entry.
 *
 * The tab lives in `?tab=` rather than in a route so the old
 * `/agents/<id>/secrets` link can redirect straight onto it.
 */
export const AgentConnectionsSection = ({ agentId }: { agentId: string }) => {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { data: counts } = useCounts();
  // The add door's open state lives here (not in the button) so the tabs'
  // empty states can open the same dialogs — one owner, many triggers.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);

  const tab = searchParams.get("tab") === "custom" ? "custom" : "apps";

  const onTabChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "apps") params.delete("tab");
    else params.set("tab", value);
    const query = params.toString();
    // Shallow: only this component reads `?tab=`, so the URL updates without
    // router.replace's server round-trip for the RSC payload (Next syncs
    // useSearchParams over history.replaceState).
    window.history.replaceState(
      null,
      "",
      query ? `${pathname}?${query}` : pathname,
    );
  };

  const countBadge = (count: number | undefined) =>
    count !== undefined && count > 0 ? (
      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
        {count}
      </Badge>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <AnimatedTabs value={tab} onValueChange={onTabChange}>
        {/* The add door sits INSIDE the tab list so the border-b rail spans
            the whole row (the connections-tabs composition). */}
        <AnimatedTabList className="justify-between gap-3">
          <div className="flex">
            <AnimatedTabTrigger
              value="apps"
              className="flex items-center gap-2"
            >
              Apps
              {countBadge(counts?.apps)}
            </AnimatedTabTrigger>
            <AnimatedTabTrigger
              value="custom"
              className="flex items-center gap-2"
            >
              Custom
              {countBadge(counts?.secrets)}
            </AnimatedTabTrigger>
          </div>
          {/* The in-place add door: connect an app or mint a custom secret
              without leaving the agent — the result is attached to THIS agent
              automatically. */}
          <AddConnectionButton
            agentId={agentId}
            tab={tab}
            pickerOpen={pickerOpen}
            onPickerOpenChange={setPickerOpen}
            secretOpen={secretOpen}
            onSecretOpenChange={setSecretOpen}
          />
        </AnimatedTabList>
      </AnimatedTabs>
      {tab === "apps" ? (
        <AppsSection
          agentId={agentId}
          onAddConnection={() => setPickerOpen(true)}
        />
      ) : (
        <SecretGrantsTab
          agentId={agentId}
          kind="secret"
          onAdd={() => setSecretOpen(true)}
        />
      )}
    </div>
  );
};
