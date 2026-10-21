"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, Plug, TriangleAlert } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import type { Connection } from "@/lib/api";
import { useConnections } from "@/hooks/use-connections";
import { useAgentGrants } from "@/hooks/use-grants";
import { useAppPermissionDefinitions } from "@/hooks/use-app-permissions";
import { useEffectiveCredentials } from "@/lib/api/policy-visibility";
import { agentActiveSets } from "@/hooks/use-agent-active-connections";
import { usePinnedPlacement } from "@/hooks/use-stable-placement";
import { connectionsPath } from "@/lib/navigation";
import { ConnectionGrantRow } from "./connection-grant-row";
import { InactiveConnections } from "./inactive-connections";
import dynamic from "next/dynamic";
import { useInstance } from "@/hooks/use-instance";

// Licensed (granular_access): the caller's "Connect your Slack" as a line in
// this list. Lazy so the free build never evaluates it; it renders nothing
// until the caller has connected, and only when the instance is entitled.
const SlackReadConnectionRow = dynamic(() =>
  import("@/ee/slack-read/slack-read-connection-row").then(
    (m) => m.SlackReadConnectionRow,
  ),
);

interface AppsTabProps {
  agentId: string;
  onManage: (connection: Connection) => void;
  /** Opens the section's in-place Add-connection picker; without it the
   * empty state falls back to linking the workspace Connections page. */
  onAddConnection?: () => void;
  /** Fold the connections that are off for this agent away (the section's
   * default). Off in the new agent's "choose connections" window, where
   * every row starts off and IS the choice. */
  foldInactive?: boolean;
}

export const AppsTab = ({
  agentId,
  onManage,
  onAddConnection,
  foldInactive = true,
}: AppsTabProps) => {
  const pathname = usePathname();
  const connectionsQuery = useConnections("workspace");
  const grantsQuery = useAgentGrants(agentId);
  const credentialsQuery = useEffectiveCredentials(agentId);
  const { data: definitions = [] } = useAppPermissionDefinitions();
  const instance = useInstance();
  const slackRow = instance?.entitled ? (
    <SlackReadConnectionRow agentId={agentId} />
  ) : null;
  // Active = switched on for this agent or granted by the organization (the
  // switch's own rule). A row the user just toggled keeps its group until the
  // next visit, so it never jumps out from under the pointer.
  const { isActiveApp } = agentActiveSets(
    grantsQuery.data,
    credentialsQuery.data,
  );
  const placement = usePinnedPlacement(isActiveApp);

  if (
    connectionsQuery.isPending ||
    grantsQuery.isPending ||
    credentialsQuery.isPending
  ) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2
          className="text-muted-foreground size-5 animate-spin"
          aria-hidden
        />
        <span className="sr-only">Loading app connections…</span>
      </div>
    );
  }
  // Never render toggle rows over a failed load — a blind toggle would write
  // against invisible state (the workspace-access-dialog rule).
  if (
    connectionsQuery.isError ||
    grantsQuery.isError ||
    credentialsQuery.isError
  ) {
    return (
      <div
        role="alert"
        className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-4 py-3 text-sm"
      >
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        Couldn&apos;t load app connections for this agent.
      </div>
    );
  }

  const pool = (connectionsQuery.data ?? []).filter(
    (c) => c.status === "connected",
  );
  if (pool.length === 0) {
    return (
      <>
        {slackRow}
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
            <Plug className="text-muted-foreground size-5" aria-hidden />
          </div>
          <p className="text-sm font-medium">No connected apps</p>
          {/* With the section's in-place door, connecting from here also grants
            this agent automatically — the empty state must not route away
            from the shortest path. */}
          {onAddConnection ? (
            <>
              <p className="text-muted-foreground mt-1 max-w-xs text-xs">
                Connect an app and this agent gets access to it automatically.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={onAddConnection}
              >
                Add connection
              </Button>
            </>
          ) : (
            <>
              <p className="text-muted-foreground mt-1 max-w-xs text-xs">
                Connect an app first, then give this agent access to it here.
              </p>
              <Button variant="outline" size="sm" className="mt-4" asChild>
                <Link href={connectionsPath({ pathname })}>
                  Go to Connections
                </Link>
              </Button>
            </>
          )}
        </Card>
      </>
    );
  }

  const grants = grantsQuery.data;
  const grantByConnection = new Map(
    (grants?.connections ?? []).map((g) => [g.connectionId, g]),
  );
  const credentialByConnection = new Map(
    (credentialsQuery.data?.connections ?? []).map((e) => [e.id, e]),
  );
  const catalogProviders = new Set(definitions.map((d) => d.provider));

  const renderRow = (connection: Connection) => {
    const grant = grantByConnection.get(connection.id);
    const credential = credentialByConnection.get(connection.id);
    const orgGranted =
      grant === undefined &&
      (credential?.provenance.some((p) => p.scope === "organization") ?? false);
    return (
      <ConnectionGrantRow
        key={connection.id}
        agentId={agentId}
        connection={connection}
        grant={grant}
        orgGranted={orgGranted}
        credentialStatus={credential?.status}
        credentialOrgBlocked={
          credential?.kind === "connection" && credential.orgBlocked
        }
        hasCatalog={catalogProviders.has(connection.provider)}
        onManage={() => onManage(connection)}
        onBeforeToggle={() => placement.pin(connection.id)}
      />
    );
  };

  // Unfolded (the new agent's chooser): every row in view, each one IS the
  // choice.
  if (!foldInactive) {
    return (
      <div className="divide-y">
        {slackRow}
        {pool.map(renderRow)}
      </div>
    );
  }

  const active = pool.filter((c) => placement.placeOf(c.id));
  const inactive = pool.filter((c) => !placement.placeOf(c.id));

  return (
    <div>
      {active.length > 0 ? (
        <div className="divide-y">
          {slackRow}
          {active.map(renderRow)}
        </div>
      ) : (
        <>
          {slackRow}
          <p className="text-muted-foreground py-6 text-center text-sm">
            No apps are on for this agent yet. Turn one on below.
          </p>
        </>
      )}
      <InactiveConnections count={inactive.length} noun="connections">
        {inactive.map(renderRow)}
      </InactiveConnections>
    </div>
  );
};
