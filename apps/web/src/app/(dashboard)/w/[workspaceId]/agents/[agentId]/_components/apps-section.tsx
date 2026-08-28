"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Connection } from "@/lib/api";
import { useConnections } from "@/hooks/use-connections";
import { useManageConnectionState } from "@/hooks/use-manage-connection-state";
import { AppsTab } from "./apps-tab";
import { ManagePermissionsDialog } from "./manage-permissions-dialog";

/**
 * The Apps entry of the Access group — today's App-connections tab, moved
 * whole (§3.18: regrouped, unchanged), together with the `?connection=&manage=1`
 * deep link the connection dialog's Manage button targets.
 */
export const AppsSection = ({
  agentId,
  onAddConnection,
}: {
  agentId: string;
  /** Opens the section's Add-connection picker — the empty state's CTA. */
  onAddConnection?: () => void;
}) => {
  const searchParams = useSearchParams();
  const { data: connections = [] } = useConnections("workspace");
  const [manageConnection, setManageConnection] = useState<Connection | null>(
    null,
  );
  const {
    grant: manageGrant,
    readOnly: manageReadOnly,
    readOnlyReason: manageReadOnlyReason,
    ready: grantsReady,
    fetching: grantsFetching,
  } = useManageConnectionState(agentId, manageConnection);

  // The `?connection=<id>&manage=1` deep link: open the manage sheet once the
  // pool resolves. Consumed per VALUE, not once per mount — the add-connection
  // dialog fires this link after every connect, and a second add in the same
  // visit must reopen the sheet for the new account.
  const consumedDeepLink = useRef<string | null>(null);
  const connectionParam = searchParams.get("connection");
  const manageParam = searchParams.get("manage");
  useEffect(() => {
    if (connectionParam === null || manageParam !== "1") return;
    if (consumedDeepLink.current === connectionParam) return;
    // The dialog derives its tri-state from the grant ONCE on open — opening
    // before the grants resolve would seed a stale "full access" view. The
    // in-flight check matters most right after the add door's auto-grant:
    // the connections refetch can deliver the new id while the grants
    // refetch is still airborne, and seeding from that stale cache would
    // show the just-granted connection as unattached.
    if (!grantsReady || grantsFetching) return;
    if (connections.length === 0) return;
    const target = connections.find((c) => c.id === connectionParam);
    if (!target) return;
    consumedDeepLink.current = connectionParam;
    setManageConnection(target);
    // CONSUME the link: strip its params (shallow — no server round-trip).
    // The guard ref resets whenever a tab flip remounts this section, so
    // stripping is the real consumption — under a still-parameterized URL
    // the sheet would re-fire on every remount.
    const params = new URLSearchParams(window.location.search);
    params.delete("connection");
    params.delete("manage");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  }, [connectionParam, manageParam, connections, grantsReady, grantsFetching]);

  return (
    <>
      <AppsTab
        agentId={agentId}
        onManage={setManageConnection}
        onAddConnection={onAddConnection}
      />
      <ManagePermissionsDialog
        agentId={agentId}
        connection={manageConnection}
        grant={manageGrant}
        readOnly={manageReadOnly}
        readOnlyReason={manageReadOnlyReason}
        onClose={() => setManageConnection(null)}
      />
    </>
  );
};
