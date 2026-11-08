"use client";

import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { TriStateControl } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/_components/tri-state-control";
import type { ReadGrant } from "./api";
import { useSetReadGrant } from "./hooks";

export interface AsYouModeCellProps {
  agentId: string;
  agentName: string;
  grant: ReadGrant;
  which: "read" | "write";
  /** The viewer's connection can post as them (Write only). */
  canWrite: boolean;
}

/** Who the agent acts as here: "you", or the granter's name. */
export const granterName = (grant: ReadGrant): string =>
  grant.mine ? "you" : grant.grantedBy.name?.trim() || grant.grantedBy.email;

/**
 * One "Reads as you" / "Writes as you" cell: the grant's tri-state. Only
 * the granter may change it (their Slack); someone else's share shows
 * read-only, saying whose it is.
 */
export const AsYouModeCell = ({
  agentId,
  agentName,
  grant,
  which,
  canWrite,
}: AsYouModeCellProps) => {
  const setGrant = useSetReadGrant(agentId);
  const label = grant.subjectLabel ?? grant.externalRef;
  const who = granterName(grant);
  const value = which === "read" ? grant.readMode : grant.writeMode;
  const control = (
    <TriStateControl
      label={
        which === "read"
          ? `Can ${agentName} read ${label} as ${who}`
          : `Can ${agentName} send in ${label} as ${who}`
      }
      value={value}
      disabled={!grant.mine}
      {...(which === "write" && {
        isOptionDisabled: (choice) =>
          canWrite || choice === "never"
            ? { disabled: false }
            : {
                disabled: true,
                why: `Reconnect your Slack to let ${agentName} send as you`,
              },
      })}
      onSelect={(choice) => {
        if (choice === value) return;
        setGrant.mutate(
          {
            externalRef: grant.externalRef,
            ...(which === "read"
              ? { readMode: choice }
              : { writeMode: choice }),
          },
          {
            onError: (err) =>
              toast.error(err instanceof Error ? err.message : "Update failed"),
          },
        );
      }}
    />
  );
  if (grant.mine) return control;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div data-testid="shared-by">{control}</div>
      </TooltipTrigger>
      <TooltipContent side="top">Shared by {who}</TooltipContent>
    </Tooltip>
  );
};
