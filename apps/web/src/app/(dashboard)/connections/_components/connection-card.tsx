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
  reconnectLabel?: string;
  onDisconnected: () => void;
}

export const ConnectionCard = ({
  connection,
  appName,
  onReconnect,
  reconnectLabel,
  onDisconnected,
}: ConnectionCardProps) => {
  const [disconnecting, setDisconnecting] = useState(false);
  const invalidateCache = useInvalidateGatewayCache();

  const displayName =
    connection.label ??
    extractLabel(connection.metadata ?? undefined) ??
    "Unknown account";

  const metadataUrl =
    typeof connection.metadata?.url === "string"
      ? connection.metadata.url
      : null;

  const repos = Array.isArray(connection.metadata?.repos)
    ? (connection.metadata.repos as string[])
    : [];

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
        {metadataUrl ? (
          <a
            href={metadataUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium truncate block hover:underline"
          >
            {displayName}
          </a>
        ) : (
          <p className="text-sm font-medium truncate">{displayName}</p>
        )}
        {repos.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 mt-1.5">
            <span className="text-[11px] font-medium text-muted-foreground/70 mr-0.5">
              Repos
            </span>
            {repos.map((repo) => (
              <span
                key={repo}
                className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {repo}
              </span>
            ))}
          </div>
        )}
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
          {reconnectLabel ?? "Reconnect"}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-400 hover:text-red-300 hover:bg-red-400/10"
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
