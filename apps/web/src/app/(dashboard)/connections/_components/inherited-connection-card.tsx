"use client";

import { useState } from "react";
import { ChevronRight, Users } from "lucide-react";
import { Card } from "@onecli/ui/components/card";
import type { PageScope } from "@/lib/api";
import { ConnectionAgentAccessSummary } from "./connection-agent-access-summary";
import { ConnectionAgentAccessDialog } from "./connection-agent-access-dialog";
// The step-9.7b read-only reflection (null stub in OSS; real under the
// POLICY_REFLECT alias) — rendered only when the flag is threaded in.
import {
  ConnectionAgentsReflection,
  REFLECTIONS_AVAILABLE,
} from "@/lib/components/policy-reflect";

interface InheritedConnectionCardProps {
  connection: { id: string; label: string | null };
  appName: string;
  pageScope?: PageScope;
  /** Step 9.7b: flag-ON, the agent-access editor renders as the read-only
   * Policy reflection instead (threaded from the RSC page). */
  policyEditingEnabled?: boolean;
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
  policyEditingEnabled = false,
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
        {showAgentAccess &&
          (policyEditingEnabled && REFLECTIONS_AVAILABLE ? (
            // Flag-ON: the old summary self-fetches equipment state, which is
            // no longer the access truth — a neutral opener replaces it.
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              aria-label="View agent access"
              className="flex min-w-0 items-center gap-1.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
            >
              <Users className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">Agent access</span>
              <ChevronRight
                className="size-3 shrink-0 opacity-60"
                aria-hidden="true"
              />
            </button>
          ) : (
            <ConnectionAgentAccessSummary
              connectionId={connection.id}
              onManage={() => setDialogOpen(true)}
            />
          ))}
      </Card>

      {showAgentAccess &&
        (policyEditingEnabled && REFLECTIONS_AVAILABLE ? (
          <ConnectionAgentsReflection
            connectionId={connection.id}
            connectionLabel={displayName}
            appName={appName}
            open={dialogOpen}
            onOpenChange={setDialogOpen}
          />
        ) : (
          <ConnectionAgentAccessDialog
            connectionId={connection.id}
            connectionLabel={displayName}
            appName={appName}
            open={dialogOpen}
            onOpenChange={setDialogOpen}
          />
        ))}
    </>
  );
};
