"use client";

import { useState } from "react";
import { Card } from "@onecli/ui/components/card";
import type { PageScope } from "@/lib/api";
import { ConnectionAgentAccessSummary } from "./connection-agent-access-summary";
import { ConnectionAgentAccessDialog } from "./connection-agent-access-dialog";

interface InheritedConnectionCardProps {
  connection: { id: string; label: string | null };
  appName: string;
  pageScope?: PageScope;
}

/**
 * An org-scoped connection surfaced (read-only) on the project page. The
 * connection itself is managed at the org level, but project agents can be
 * granted access to it — so the agent-access line/dialog are shown (project
 * scope only).
 */
export const InheritedConnectionCard = ({
  connection,
  appName,
  pageScope = "project",
}: InheritedConnectionCardProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const displayName = connection.label ?? "Connected account";
  const showAgentAccess = pageScope === "project";

  return (
    <>
      <Card className="gap-2 border-dashed px-4 py-3 opacity-70">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{displayName}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Organization</p>
          </div>
        </div>
        {showAgentAccess && (
          <ConnectionAgentAccessSummary
            connectionId={connection.id}
            onManage={() => setDialogOpen(true)}
          />
        )}
      </Card>

      {showAgentAccess && (
        <ConnectionAgentAccessDialog
          connectionId={connection.id}
          connectionLabel={displayName}
          appName={appName}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
    </>
  );
};
