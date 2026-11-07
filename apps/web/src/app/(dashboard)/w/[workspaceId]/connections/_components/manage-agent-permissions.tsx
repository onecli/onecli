"use client";

import { useManageConnectionState } from "@/hooks/use-manage-connection-state";
import { useGrantSettling } from "@/hooks/use-grants";
import { ManagePermissionsDialog } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/_components/manage-permissions-dialog";
import type { AccountCardConnection } from "./account-card-connection";

export interface ManageAgentPermissionsProps {
  agentId: string;
  /** The real connection row: the resource picker reads its metadata (a
   * GitHub App installation's repos). */
  connection: AccountCardConnection;
  onClose: () => void;
}

/**
 * One agent's permissions for one account, opened from the connections page.
 * The same sheet as the agent page's Manage, under the same read-only law
 * (`useManageConnectionState`), and only once that agent's grant has loaded:
 * the sheet seeds its choices once on open, so opening early would show a
 * stale "full access". Also held while a write to this grant is settling
 * (the switch's toast offers this sheet at click time): a read racing the
 * write could seed the pre-click grant.
 */
export const ManageAgentPermissions = ({
  agentId,
  connection,
  onClose,
}: ManageAgentPermissionsProps) => {
  const { grant, readOnly, readOnlyReason, ready, fetching } =
    useManageConnectionState(agentId, connection);
  const settling = useGrantSettling(agentId, "connection", connection.id);

  return (
    <ManagePermissionsDialog
      agentId={agentId}
      connection={ready && !fetching && !settling ? connection : null}
      grant={grant}
      readOnly={readOnly}
      readOnlyReason={readOnlyReason}
      onClose={onClose}
    />
  );
};
