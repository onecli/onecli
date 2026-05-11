"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, MoreVertical, RefreshCw, Unplug } from "lucide-react";
import { Card } from "@onecli/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import { Button } from "@onecli/ui/components/button";
import { disconnectAppConnection } from "@/lib/actions/connections";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { extractLabel } from "@/lib/services/connection-service";

interface ConnectionAccountCardProps {
  connection: {
    id: string;
    label: string | null;
    status: string;
    scopes: string[];
    metadata: Record<string, unknown> | null;
    connectedAt: Date;
  };
  appName: string;
  onReconnect: (connectionId: string) => void;
  onDisconnected: () => void;
}

export const ConnectionAccountCard = ({
  connection,
  appName,
  onReconnect,
  onDisconnected,
}: ConnectionAccountCardProps) => {
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const invalidateCache = useInvalidateGatewayCache();

  const displayName =
    connection.label ??
    extractLabel(connection.metadata ?? undefined) ??
    "Unknown account";

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnectAppConnection(connection.id);
      invalidateCache();
      onDisconnected();
      toast.success(`${appName} account disconnected`);
    } catch {
      toast.error("Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <>
      <Card className="flex-row items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{displayName}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Connected{" "}
            {new Date(connection.connectedAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground"
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onReconnect(connection.id)}>
              <RefreshCw className="size-4" />
              Reconnect
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setConfirmOpen(true)}
              disabled={disconnecting}
              className="text-destructive focus:text-destructive"
            >
              {disconnecting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Unplug className="size-4" />
              )}
              {disconnecting ? "Disconnecting..." : "Disconnect"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will revoke access and remove the stored credentials for this{" "}
              {appName} account. Agents using this connection will no longer be
              able to authenticate.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnect}
              variant="destructive"
              disabled={disconnecting}
            >
              {disconnecting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                "Disconnect"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
