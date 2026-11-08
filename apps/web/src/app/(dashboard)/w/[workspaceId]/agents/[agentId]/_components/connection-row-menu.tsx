"use client";

import { displayConnectionLabel } from "@onecli/api/lib/connection-display";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { MoreVertical, Pencil, Plug, RefreshCw } from "lucide-react";
import { getApp } from "@onecli/api/apps/registry";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import type { Connection } from "@/lib/api";
import { connectPopupHeight, openConnectPopup } from "@/lib/connect-popup";
import { WORKSPACE_PATH_RE, connectionsPath } from "@/lib/navigation";
import { RenameConnectionDialog } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/rename-connection-dialog";
import { ReconnectWatcher } from "./reconnect-watcher";

export interface ConnectionRowMenuProps {
  connection: Connection;
  /** On for this agent (the switch's state). */
  active: boolean;
}

/** The ⋮'s footprint, flush with the row's edge. Shared with the empty slot
 * a row with nothing to offer keeps, so every row's switch lines up. */
const slotClassName = "-mr-1.5 size-7 shrink-0";

/**
 * The row's ⋮ menu on an agent's Connections page. Every row opens the app's
 * page in the workspace's Connections, where its accounts, credentials and
 * sharing live. The workspace's own connections also Reconnect and Rename;
 * an organization connection is managed on the organization's Connections
 * page, like everywhere else in a workspace. Turning a connection on or off
 * for this agent is the row's switch.
 */
export const ConnectionRowMenu = ({
  connection,
  active,
}: ConnectionRowMenuProps) => {
  const pathname = usePathname();
  const [renameOpen, setRenameOpen] = useState(false);
  // A reconnect popup this menu opened is in flight (see ReconnectWatcher).
  const [reconnecting, setReconnecting] = useState(false);
  const app = getApp(connection.provider);
  const manageable = connection.scope !== "organization";
  // Accounts managed on the provider's side (a GitHub App installation)
  // carry a settings link instead of a re-auth, as on the account card.
  const meta = connection.metadata;
  const providerManaged =
    !!meta &&
    typeof meta === "object" &&
    "manageUrl" in meta &&
    !!meta.manageUrl;
  const canReconnect = manageable && active && !providerManaged && !!app;
  const displayName =
    displayConnectionLabel(connection.label, connection.metadata) ??
    app?.name ??
    connection.provider;
  // Nothing to offer: an organization connection whose app is gone from the
  // registry (its page would 404). The slot stays, so the switch lines up.
  if (!manageable && !app)
    return <span aria-hidden className={slotClassName} />;

  const reconnect = () => {
    if (!app) return;
    const popup = openConnectPopup(app.id, {
      connectionId: connection.id,
      workspaceId: pathname.match(WORKSPACE_PATH_RE)?.[1],
      height: connectPopupHeight(app),
    });
    if (popup) {
      setReconnecting(true);
    } else {
      toast.error("Popup blocked. Allow popups for this site and try again.");
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-muted-foreground", slotClassName)}
            aria-label={`More actions for ${displayName}`}
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canReconnect && (
            <DropdownMenuItem onClick={reconnect}>
              <RefreshCw className="size-4" />
              Reconnect
            </DropdownMenuItem>
          )}
          {manageable && (
            <DropdownMenuItem onClick={() => setRenameOpen(true)}>
              <Pencil className="size-4" />
              Rename
            </DropdownMenuItem>
          )}
          {manageable && app && <DropdownMenuSeparator />}
          {app && (
            <DropdownMenuItem asChild>
              <Link
                href={connectionsPath(
                  { pathname },
                  `/apps/${encodeURIComponent(app.id)}`,
                )}
              >
                <Plug className="size-4" />
                Open in Connections
              </Link>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {manageable && (
        <RenameConnectionDialog
          connectionId={connection.id}
          initialLabel={connection.label ?? ""}
          scope="workspace"
          open={renameOpen}
          onOpenChange={setRenameOpen}
        />
      )}
      {reconnecting && (
        <ReconnectWatcher
          provider={connection.provider}
          onDone={() => setReconnecting(false)}
        />
      )}
    </>
  );
};
