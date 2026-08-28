"use client";

import type { AgentGrantConnection, Connection } from "@/lib/api";
import { useAgentGrants } from "@/hooks/use-grants";
import { useEffectiveCredentials } from "@/lib/api/policy-visibility";

export interface ManageConnectionState {
  /** The agent's workspace grant on the connection, once grants resolve. */
  grant: AgentGrantConnection | undefined;
  /** Org-granted or org-blocked — the workspace view opens read-only. */
  readOnly: boolean;
  /** Which read-only copy the dialog shows; undefined when editable. */
  readOnlyReason: "org-granted" | "org-blocked" | undefined;
  /** Grants and effective credentials resolved. The manage dialog derives
   * its tri-state from the grant ONCE on open — opening before this turns
   * true would seed a stale "full access" view (and show an org-locked
   * connection as editable) — so callers must gate the open on it. */
  ready: boolean;
  /** A grants/credentials refetch is in flight. `ready` alone is satisfied
   * by stale cache, so a programmatic open racing a fresh write (the add
   * door's auto-grant deep link) must also wait for this to clear — seeding
   * mid-refetch would show a just-granted connection as unattached. Manual
   * Manage clicks don't need it: by click time the write's refetch has
   * landed. */
  fetching: boolean;
}

/**
 * The manage-permissions read-only law, in one place for every surface that
 * opens `ManagePermissionsDialog` (the agent page's Apps section, the chat's
 * connect card):
 *
 * - Org-granted (no workspace grant, injected by an ORG rule) → read-only
 *   view. A plain unattached connection stays editable: Manage-before-attach
 *   saves a customized grant in one step.
 * - Under an org-wide block there is nothing a workspace admin can usefully
 *   change — every tool is already at the organization's floor.
 */
export const useManageConnectionState = (
  agentId: string,
  connection: Connection | null,
): ManageConnectionState => {
  // Both fetch eagerly (not gated on a selected connection) so the law is
  // already decided the moment a Manage affordance is clicked — both queries
  // are per-agent-keyed and deduped across every card and section on the page.
  const grantsQuery = useAgentGrants(agentId);
  const credentialsQuery = useEffectiveCredentials(agentId);

  const grant = connection
    ? grantsQuery.data?.connections.find(
        (g) => g.connectionId === connection.id,
      )
    : undefined;
  const credential = connection
    ? credentialsQuery.data?.connections.find((e) => e.id === connection.id)
    : undefined;

  const orgGranted =
    connection !== null &&
    grant === undefined &&
    (credential?.provenance.some((p) => p.scope === "organization") ?? false);
  const orgBlocked = credential?.kind === "connection" && credential.orgBlocked;

  return {
    grant,
    readOnly: orgGranted || orgBlocked,
    readOnlyReason: orgBlocked
      ? "org-blocked"
      : orgGranted
        ? "org-granted"
        : undefined,
    ready: !grantsQuery.isPending && !credentialsQuery.isPending,
    fetching: grantsQuery.isFetching || credentialsQuery.isFetching,
  };
};
