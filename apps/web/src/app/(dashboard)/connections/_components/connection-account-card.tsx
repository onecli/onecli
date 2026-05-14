"use client";

import { useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import {
  Building2,
  Loader2,
  MoreVertical,
  RefreshCw,
  Settings,
  Unplug,
  User,
} from "lucide-react";
import { Card } from "@onecli/ui/components/card";
import { Badge } from "@onecli/ui/components/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { extractLabel } from "@onecli/api/services/connection-service";

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

  const avatarUrl = connection.metadata?.avatarUrl as string | undefined;
  const accountType = connection.metadata?.accountType as string | undefined;
  const tags = (connection.metadata?.tags as string[] | undefined) ?? [];

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
      <Card className="gap-2 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {avatarUrl ? (
              <Image
                src={avatarUrl}
                alt={displayName}
                width={28}
                height={28}
                unoptimized
                className="size-7 rounded-full shrink-0"
              />
            ) : (
              <div className="flex size-7 items-center justify-center rounded-full bg-muted shrink-0">
                {accountType === "Organization" ? (
                  <Building2 className="size-3.5 text-muted-foreground" />
                ) : (
                  <User className="size-3.5 text-muted-foreground" />
                )}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{displayName}</p>
              <p className="text-xs text-muted-foreground">
                {accountType ?? "Connected"}{" "}
                <span className="text-muted-foreground/60">
                  &middot;{" "}
                  {new Date(connection.connectedAt).toLocaleDateString(
                    "en-US",
                    { month: "short", day: "numeric", year: "numeric" },
                  )}
                </span>
              </p>
            </div>
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
              {!!connection.metadata?.manageUrl && (
                <DropdownMenuItem asChild>
                  <a
                    href={connection.metadata.manageUrl as string}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Settings className="size-4" />
                    Settings
                  </a>
                </DropdownMenuItem>
              )}
              {!connection.metadata?.manageUrl && (
                <DropdownMenuItem onClick={() => onReconnect(connection.id)}>
                  <RefreshCw className="size-4" />
                  Reconnect
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
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
        </div>

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}
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
