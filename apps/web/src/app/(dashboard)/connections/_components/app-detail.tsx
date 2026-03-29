"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
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
import { getAppConnections, disconnectApp } from "@/lib/actions/connections";
import { useAppConnected } from "@/hooks/use-app-connected";
import { AppIcon } from "./app-icon";
import { AppConfigForm } from "./app-config-form";

interface AppDetailProps {
  app: {
    id: string;
    name: string;
    icon: string;
    darkIcon?: string;
    description: string;
    connectionType: string;
    defaultScopes: string[];
  };
  hasDefaults: boolean;
  configurable?: {
    fields: {
      name: string;
      label: string;
      description?: string;
      placeholder: string;
      secret?: boolean;
    }[];
    envDefaults: Record<string, string>;
  };
  hasEnvDefaults: boolean;
}

interface ConnectionData {
  id: string;
  provider: string;
  status: string;
  scopes: string[];
  metadata: Record<string, unknown> | null;
  connectedAt: Date;
}

export const AppDetail = ({
  app,
  hasDefaults,
  configurable,
  hasEnvDefaults,
}: AppDetailProps) => {
  const [connection, setConnection] = useState<ConnectionData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchConnection = useCallback(async () => {
    try {
      const connections = await getAppConnections();
      const match = connections.find(
        (c) => c.provider === app.id && c.status === "connected",
      );
      setConnection(
        match
          ? {
              ...match,
              metadata: match.metadata as Record<string, unknown> | null,
            }
          : null,
      );
    } catch {
      // Connection fetch failed — show as disconnected
    } finally {
      setLoading(false);
    }
  }, [app.id]);

  useEffect(() => {
    fetchConnection();
  }, [fetchConnection]);

  useAppConnected(fetchConnection);

  const handleConnect = () => {
    const w = 520;
    const h = 700;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
    window.open(
      `/app-connect/${app.id}`,
      `connect-${app.id}`,
      `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`,
    );
  };

  const handleDisconnect = async () => {
    try {
      await disconnectApp(app.id);
      setConnection(null);
      toast.success(`${app.name} disconnected`);
    } catch {
      toast.error("Failed to disconnect");
    }
  };

  const isConnected = !!connection;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/connections"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Apps
      </Link>

      {/* Header with actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-muted">
            <AppIcon
              icon={app.icon}
              darkIcon={app.darkIcon}
              name={app.name}
              size={24}
            />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight">
                {app.name}
              </h1>
              {isConnected && (
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-brand" />
                  <span className="text-xs font-medium text-brand">
                    Connected
                  </span>
                </div>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {app.description}
            </p>
          </div>
        </div>

        {/* Actions in header */}
        {!loading && (
          <div className="flex items-center gap-2 shrink-0">
            {isConnected ? (
              <>
                <Button variant="outline" size="sm" onClick={handleConnect}>
                  Reconnect
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    >
                      Disconnect
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Disconnect {app.name}?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        This will revoke access and remove the stored
                        credentials. Agents using this connection will no longer
                        be able to authenticate with {app.name}.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDisconnect}
                        className="bg-destructive text-white hover:bg-destructive/90"
                      >
                        Disconnect
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            ) : hasDefaults ? (
              <Button size="sm" onClick={handleConnect}>
                Connect {app.name}
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : isConnected ? (
        <ConnectionInfo connection={connection} />
      ) : app.defaultScopes.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Connecting will request {app.defaultScopes.length} permission
            {app.defaultScopes.length !== 1 ? "s" : ""}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {app.defaultScopes.map((scope) => (
              <Badge
                key={scope}
                variant="outline"
                className="text-[11px] font-mono text-muted-foreground"
              >
                {scope}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {configurable && (
        <AppConfigForm
          provider={app.id}
          appName={app.name}
          fields={configurable.fields}
          hasEnvDefaults={hasEnvDefaults}
        />
      )}
    </div>
  );
};

const ConnectionInfo = ({ connection }: { connection: ConnectionData }) => {
  const username =
    (connection.metadata?.username as string) ??
    (connection.metadata?.name as string);

  return (
    <div className="space-y-5">
      {/* Key-value metadata */}
      <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {username && (
          <>
            <span className="text-muted-foreground">Account</span>
            <span className="font-medium">{username}</span>
          </>
        )}
        <span className="text-muted-foreground">Connected</span>
        <span className="font-medium">
          {new Date(connection.connectedAt).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </span>
        {connection.scopes.length > 0 && (
          <>
            <span className="text-muted-foreground pt-0.5">Scopes</span>
            <div className="flex flex-wrap gap-1.5">
              {connection.scopes.map((scope) => (
                <Badge
                  key={scope}
                  variant="outline"
                  className="text-[11px] font-mono text-muted-foreground"
                >
                  {scope}
                </Badge>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
