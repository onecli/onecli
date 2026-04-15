"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@onecli/ui/components/alert-dialog";
import { disconnectAppConnection } from "@/lib/actions/connections";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { extractLabel } from "@/lib/services/connection-service";

interface ConnectionCardProps {
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

export const ConnectionCard = ({
  connection,
  appName,
  onReconnect,
  onDisconnected,
}: ConnectionCardProps) => {
  const [disconnecting, setDisconnecting] = useState(false);
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
    <Card className="flex-row items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{displayName}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Connected{" "}
          {new Date(connection.connectedAt).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onReconnect(connection.id)}
        >
          Reconnect
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
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
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect {displayName}?</AlertDialogTitle>
              <AlertDialogDescription>
                This will revoke access and remove the stored credentials for
                this {appName} account. Agents using this connection will no
                longer be able to authenticate.
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
      </div>
    </Card>
  );
};
