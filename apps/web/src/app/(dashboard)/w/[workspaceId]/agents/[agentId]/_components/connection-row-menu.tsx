"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { MoreVertical, Pencil, Power, PowerOff, RefreshCw } from "lucide-react";
import { getApp } from "@onecli/api/apps/registry";
import { Button } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import type { Connection } from "@/lib/api";
import { connectPopupHeight, openConnectPopup } from "@/lib/connect-popup";
import { WORKSPACE_PATH_RE } from "@/lib/navigation";
import { RenameConnectionDialog } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/rename-connection-dialog";
import { ReconnectWatcher } from "./reconnect-watcher";

export interface ConnectionRowMenuProps {
  connection: Connection;
  /** On for this agent (the switch's state). */
  active: boolean;
  /** The switch can't change right now (org-granted, org-blocked, busy). */
  toggleDisabled: boolean;
  onToggle: (next: boolean) => void;
}

/**
 * The row's ⋮ menu on an agent's Connections page: Turn on/off (the row's
 * switch, offered here too), plus Reconnect and Rename for the workspace's
 * own connections. An organization connection is managed on the
 * organization's Connections page, like everywhere else in a workspace, so
 * here it only turns on or off for this agent.
 */
export const ConnectionRowMenu = ({
  connection,
  active,
  toggleDisabled,
  onToggle,
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
  const displayName = connection.label ?? app?.name ?? connection.provider;

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
            className="text-muted-foreground -mr-1.5 size-7 shrink-0"
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
          {manageable && <DropdownMenuSeparator />}
          <DropdownMenuItem
            disabled={toggleDisabled}
            onClick={() => onToggle(!active)}
          >
            {active ? (
              <PowerOff className="size-4" />
            ) : (
              <Power className="size-4" />
            )}
            {active ? "Turn off for this agent" : "Turn on for this agent"}
          </DropdownMenuItem>
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
