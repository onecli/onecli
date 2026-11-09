"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AnimatedTabs,
  AnimatedTabList,
  AnimatedTabTrigger,
} from "@onecli/ui/components/animated-tabs";
import { PageHeader } from "@dashboard/page-header";
import { SettingsSection } from "@dashboard/settings-section";
import { AppsTab } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/apps-tab";
import { ConnectedTab } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/connected-tab";
import { SecretsContent } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/secrets-content";
import { EnterpriseLockedCard } from "@/lib/components/enterprise-locked-card";
import { useOrgConnectionsPath } from "@/lib/org-navigation";
import {
  createOrgSecretAction,
  deleteOrgSecretAction,
  getOrgSecrets,
  updateOrgSecretAction,
} from "@/lib/actions/org-secrets";
import { AppAvailabilityEditor } from "@/ee/app-availability/_components/app-availability-editor";
import { useReplaceParam } from "./use-replace-param";

/**
 * Organization > Shared apps in the modal: the Shared Connections tabs
 * (Apps, Custom, LLMs, Connected) as one page, with the app-availability
 * allowlist below them as a section.
 * Same components as the route pages, same org-scope actions; the tab
 * lives in `?tab=` so the modal stays open. Reads `useSearchParams`: the
 * slot's Suspense boundary holds it.
 */

const TABS = ["apps", "custom", "llms", "connected"] as const;
type Tab = (typeof TABS)[number];

const isTab = (v: string | null): v is Tab => TABS.some((t) => t === v);

const orgSecretActions = {
  createSecret: createOrgSecretAction,
  deleteSecret: deleteOrgSecretAction,
  updateSecret: updateOrgSecretAction,
};

export const SharedAppsBody = ({ entitled }: { entitled: boolean }) => {
  const params = useSearchParams();
  const replaceParam = useReplaceParam();
  const basePath = useOrgConnectionsPath();
  const raw = params.get("tab");
  const tab: Tab = isTab(raw) ? raw : "apps";
  // The Apps tab's search sits in the tab strip, above its line.
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        character="cloud-think"
        title="Shared apps"
        description="Connect an app once and share it with every workspace. Each workspace chooses which of its agents use it."
      />
      <AnimatedTabs
        value={tab}
        onValueChange={(v) => replaceParam("tab", v === "apps" ? null : v)}
      >
        <AnimatedTabList>
          <AnimatedTabTrigger value="apps">Apps</AnimatedTabTrigger>
          <AnimatedTabTrigger value="custom">Custom</AnimatedTabTrigger>
          <AnimatedTabTrigger value="llms">LLMs</AnimatedTabTrigger>
          <AnimatedTabTrigger value="connected">Connected</AnimatedTabTrigger>
          <div ref={setSearchSlot} className="ml-auto pb-1.5 pl-3" />
        </AnimatedTabList>
      </AnimatedTabs>
      {tab === "apps" && (
        <AppsTab
          pageScope="organization"
          basePath={basePath}
          searchSlot={searchSlot}
        />
      )}
      {tab === "custom" && (
        <SecretsContent
          typeFilter="generic"
          getSecrets={getOrgSecrets}
          secretActions={orgSecretActions}
          pageScope="organization"
        />
      )}
      {tab === "llms" && (
        <SecretsContent
          typeFilter="llm"
          getSecrets={getOrgSecrets}
          secretActions={orgSecretActions}
          pageScope="organization"
        />
      )}
      {tab === "connected" && (
        <ConnectedTab
          getSecrets={getOrgSecrets}
          basePath={basePath}
          secretActions={orgSecretActions}
          pageScope="organization"
        />
      )}
      <SettingsSection
        title="Apps workspaces can connect"
        description="Choose which apps each workspace may connect, based on who has access to it."
      >
        {entitled ? (
          <AppAvailabilityEditor />
        ) : (
          <EnterpriseLockedCard
            feature="app_availability"
            description="Restrict which apps each workspace may connect, based on who has access to it."
          />
        )}
      </SettingsSection>
    </div>
  );
};
