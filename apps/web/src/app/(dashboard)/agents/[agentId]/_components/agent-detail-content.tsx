"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bot } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  AnimatedTabs,
  AnimatedTabList,
  AnimatedTabTrigger,
  AnimatedTabContent,
} from "@onecli/ui/components/animated-tabs";
import type { Connection } from "@/lib/api";
import { useAgents } from "@/hooks/use-agents";
import { useAgentGrants } from "@/hooks/use-grants";
import { useConnections } from "@/hooks/use-connections";
import { useSecrets } from "@/hooks/use-secrets";
import { useEffectiveCredentials } from "@/lib/api/policy-visibility";
import { withProjectPrefix } from "@/lib/navigation";
import { AgentHeader } from "./agent-header";
import { AppsTab } from "./apps-tab";
import { SecretGrantsTab } from "./secret-grants-tab";
import { ManagePermissionsDialog } from "./manage-permissions-dialog";

const TABS = ["apps", "secrets", "llms"] as const;
type TabValue = (typeof TABS)[number];

const isTab = (value: string | null): value is TabValue =>
  value !== null && (TABS as readonly string[]).includes(value);

export const AgentDetailContent = ({ agentId }: { agentId: string }) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const { data: agents = [], isPending } = useAgents();
  const agent = agents.find((a) => a.id === agentId);
  const grantsQuery = useAgentGrants(agentId);
  const credentialsQuery = useEffectiveCredentials(agentId);
  const { data: connections = [] } = useConnections("project");
  const { data: secrets = [] } = useSecrets();

  const tabParam = searchParams.get("tab");
  const tab: TabValue = isTab(tabParam) ? tabParam : "apps";
  const [manageConnection, setManageConnection] = useState<Connection | null>(
    null,
  );

  const setTab = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", value);
      // Deep-link params are one-shot — a tab switch clears them.
      params.delete("connection");
      params.delete("manage");
      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      });
    },
    [searchParams, router, pathname],
  );

  // The `?connection=<id>&manage=1` deep link (the connection dialog's Manage
  // button target in step 4): open the manage sheet once the pool resolves.
  // One-shot — consumed at most once per mount (the secrets-content pattern).
  const consumedDeepLink = useRef(false);
  const connectionParam = searchParams.get("connection");
  const manageParam = searchParams.get("manage");
  const grantsReady = !grantsQuery.isPending;
  useEffect(() => {
    if (consumedDeepLink.current) return;
    if (connectionParam === null || manageParam !== "1") return;
    // The dialog derives its tri-state from the grant ONCE on open — opening
    // before the grants resolve would seed a stale "full access" view.
    if (!grantsReady) return;
    if (connections.length === 0) return;
    const target = connections.find((c) => c.id === connectionParam);
    if (!target) return;
    consumedDeepLink.current = true;
    setManageConnection(target);
  }, [connectionParam, manageParam, connections, grantsReady]);

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-16" />
        <div className="flex items-center gap-4">
          <Skeleton className="size-12 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
        </div>
        <Skeleton className="h-9 w-64" />
      </div>
    );
  }

  if (!agent) {
    return (
      <Card className="flex flex-col items-center justify-center py-16 text-center">
        <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
          <Bot className="text-muted-foreground size-5" aria-hidden />
        </div>
        <p className="text-sm font-medium">Agent not found</p>
        <p className="text-muted-foreground mt-1 max-w-xs text-xs">
          It may have been deleted, or the link points at another project.
        </p>
        <Button variant="outline" size="sm" className="mt-4" asChild>
          <Link href={withProjectPrefix(pathname, "/agents")}>
            Back to Agents
          </Link>
        </Button>
      </Card>
    );
  }

  const grantByConnection = new Map(
    (grantsQuery.data?.connections ?? []).map((g) => [g.connectionId, g]),
  );
  const connectedCount = connections.filter(
    (c) => c.status === "connected",
  ).length;
  const nonPartnerSecrets = secrets.filter((s) => s.scope !== "partner");
  const secretCount = nonPartnerSecrets.filter(
    (s) => s.type === "generic",
  ).length;
  const llmCount = nonPartnerSecrets.filter((s) => s.type !== "generic").length;

  const manageGrant = manageConnection
    ? grantByConnection.get(manageConnection.id)
    : undefined;
  // Org-granted (no project grant, injected by an ORG rule) → read-only view.
  // A plain unattached connection stays editable: Manage-before-attach saves a
  // customized grant in one step.
  const manageOrgGranted =
    manageConnection !== null &&
    manageGrant === undefined &&
    (credentialsQuery.data?.connections
      .find((e) => e.id === manageConnection.id)
      ?.provenance.some((p) => p.scope === "organization") ??
      false);
  const manageReadOnly = manageOrgGranted;

  const countBadge = (count: number) =>
    count > 0 && (
      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
        {count}
      </Badge>
    );

  return (
    <div className="space-y-6">
      <AgentHeader agent={agent} />

      <AnimatedTabs value={tab} onValueChange={setTab}>
        <AnimatedTabList>
          <AnimatedTabTrigger value="apps" className="flex items-center gap-2">
            <span className="sm:hidden">Apps</span>
            <span className="hidden sm:inline">App connections</span>
            {countBadge(connectedCount)}
          </AnimatedTabTrigger>
          <AnimatedTabTrigger
            value="secrets"
            className="flex items-center gap-2"
          >
            Secrets
            {countBadge(secretCount)}
          </AnimatedTabTrigger>
          <AnimatedTabTrigger value="llms" className="flex items-center gap-2">
            LLMs
            {countBadge(llmCount)}
          </AnimatedTabTrigger>
        </AnimatedTabList>
        <div className="mt-4">
          <AnimatedTabContent value="apps">
            <AppsTab agentId={agentId} onManage={setManageConnection} />
          </AnimatedTabContent>
          <AnimatedTabContent value="secrets">
            <SecretGrantsTab agentId={agentId} kind="secret" />
          </AnimatedTabContent>
          <AnimatedTabContent value="llms">
            <SecretGrantsTab agentId={agentId} kind="llm" />
          </AnimatedTabContent>
        </div>
      </AnimatedTabs>

      <ManagePermissionsDialog
        agentId={agentId}
        connection={manageConnection}
        grant={manageGrant}
        readOnly={manageReadOnly}
        onClose={() => setManageConnection(null)}
      />
    </div>
  );
};
