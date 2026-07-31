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
import { connectionsPath } from "@/lib/navigation";
import { ConnectionGrantRow } from "./connection-grant-row";

interface AppsTabProps {
  agentId: string;
  onManage: (connection: Connection) => void;
}

export const AppsTab = ({ agentId, onManage }: AppsTabProps) => {
  const pathname = usePathname();
  const connectionsQuery = useConnections("project");
  const grantsQuery = useAgentGrants(agentId);
  const credentialsQuery = useEffectiveCredentials(agentId);
  const { data: definitions = [] } = useAppPermissionDefinitions();

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
  // against invisible state (the project-access-dialog rule).
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
      <Card className="flex flex-col items-center justify-center py-16 text-center">
        <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
          <Plug className="text-muted-foreground size-5" aria-hidden />
        </div>
        <p className="text-sm font-medium">No connected apps</p>
        <p className="text-muted-foreground mt-1 max-w-xs text-xs">
          Connect an app first, then give this agent access to it here.
        </p>
        <Button variant="outline" size="sm" className="mt-4" asChild>
          <Link href={connectionsPath({ pathname })}>Go to Connections</Link>
        </Button>
      </Card>
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

  return (
    <div className="divide-y">
      {pool.map((connection) => {
        const grant = grantByConnection.get(connection.id);
        const credential = credentialByConnection.get(connection.id);
        const orgGranted =
          grant === undefined &&
          (credential?.provenance.some((p) => p.scope === "organization") ??
            false);
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
          />
        );
      })}
    </div>
  );
};
