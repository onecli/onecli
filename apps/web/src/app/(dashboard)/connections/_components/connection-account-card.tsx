"use client";

import { useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import {
  Building2,
  Loader2,
  MoreVertical,
  Pencil,
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  useDisconnectConnection,
  useRenameConnection,
} from "@/hooks/use-connections";
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
  refetchConnections: () => void;
  pageScope?: "project" | "organization";
}

export const ConnectionAccountCard = ({
  connection,
  appName,
  onReconnect,
  refetchConnections,
  pageScope = "project",
}: ConnectionAccountCardProps) => {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const disconnectMutation = useDisconnectConnection(pageScope);
  const renameMutation = useRenameConnection();

  const displayName =
    connection.label ??
    extractLabel(connection.metadata ?? undefined) ??
    "Unknown account";

  const avatarUrl = connection.metadata?.avatarUrl as string | undefined;
  const accountType = connection.metadata?.accountType as string | undefined;
  const tags = (connection.metadata?.tags as string[] | undefined) ?? [];

  const handleRename = () => {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    renameMutation.mutate(
      { id: connection.id, label: trimmed },
      {
        onSuccess: () => {
          refetchConnections();
          toast.success("Connection renamed");
          setRenameOpen(false);
        },
      },
    );
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate(connection.id, {
      onSuccess: () => {
        refetchConnections();
        toast.success(`${appName} account disconnected`);
      },
    });
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
              <DropdownMenuItem
                onClick={() => {
                  setRenameValue(
                    displayName === "Unknown account" ? "" : displayName,
                  );
                  setRenameOpen(true);
                }}
              >
                <Pencil className="size-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setConfirmOpen(true)}
                disabled={disconnectMutation.isPending}
                className="text-destructive focus:text-destructive"
              >
                {disconnectMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Unplug className="size-4" />
                )}
                {disconnectMutation.isPending
                  ? "Disconnecting..."
                  : "Disconnect"}
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
              disabled={disconnectMutation.isPending}
            >
              {disconnectMutation.isPending ? (
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

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename connection</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5 py-2">
            <Label htmlFor="rename-label">Label</Label>
            <Input
              id="rename-label"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="e.g. work, personal"
              className="font-mono text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              onClick={handleRename}
              disabled={!renameValue.trim() || renameMutation.isPending}
              loading={renameMutation.isPending}
              size="sm"
            >
              {renameMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
