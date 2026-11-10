"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AnimatedTabs,
  AnimatedTabList,
  AnimatedTabTrigger,
} from "@onecli/ui/components/animated-tabs";
import { PageHeader } from "@dashboard/page-header";
import { AppsTab } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/apps-tab";
import { ConnectedTab } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/connected-tab";
import { SecretsContent } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/secrets-content";
import { VaultsTab } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/vaults-tab";
import { CreateSecretButton } from "@/lib/connections/_components/create-secret-button";
import { useReplaceParam } from "./use-replace-param";

/**
 * Workspace > Apps in the modal: the workspace Connections section's tabs
 * (Apps, Custom, LLMs, Vaults, Connected) as one page. The tab components
 * are the route pages' own; only the strip differs: the route strip
 * navigates between `/connections/<tab>` URLs, which would leave the
 * modal, so this one keeps the tab in `?tab=` instead. An app's own page
 * and a vault's setup open inside the modal too (`?app=`, `?vault=`;
 * `bodies.tsx` picks them before this list). Reads `useSearchParams`: the
 * slot's Suspense boundary holds it.
 */

const TABS = ["apps", "custom", "llms", "vaults", "connected"] as const;
type Tab = (typeof TABS)[number];

const isTab = (v: string | null): v is Tab => TABS.some((t) => t === v);

export const WorkspaceAppsBody = () => {
  const params = useSearchParams();
  const replaceParam = useReplaceParam();
  const raw = params.get("tab");
  const tab: Tab = isTab(raw) ? raw : "apps";
  // The Apps tab's search sits in the tab strip, right of the tabs and
  // above its line, not in the filter row under it.
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        character="cloud-key"
        title="Apps"
        description="Everything connected in this workspace: apps, custom secrets, LLM keys, and external vaults. Agents use them without ever seeing a key."
      />
      <AnimatedTabs
        value={tab}
        onValueChange={(v) => replaceParam("tab", v === "apps" ? null : v)}
      >
        <AnimatedTabList>
          <AnimatedTabTrigger value="apps">Apps</AnimatedTabTrigger>
          <AnimatedTabTrigger value="custom">Custom</AnimatedTabTrigger>
          <AnimatedTabTrigger value="llms">LLMs</AnimatedTabTrigger>
          <AnimatedTabTrigger value="vaults">Vaults</AnimatedTabTrigger>
          <AnimatedTabTrigger value="connected">Connected</AnimatedTabTrigger>
          <div ref={setSearchSlot} className="ml-auto pb-1.5 pl-3" />
        </AnimatedTabList>
      </AnimatedTabs>
      {tab === "apps" && <AppsTab searchSlot={searchSlot} />}
      {tab === "custom" && (
        <SecretsContent
          typeFilter="generic"
          renderCreateButton={(onCreate) => (
            <CreateSecretButton onCreate={onCreate} label="Add connection" />
          )}
        />
      )}
      {tab === "llms" && (
        <SecretsContent
          typeFilter="llm"
          renderCreateButton={(onCreate) => (
            <CreateSecretButton onCreate={onCreate} label="Add LLM Key" />
          )}
        />
      )}
      {tab === "vaults" && <VaultsTab />}
      {tab === "connected" && <ConnectedTab />}
    </div>
  );
};
