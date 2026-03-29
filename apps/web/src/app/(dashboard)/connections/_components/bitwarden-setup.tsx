"use client";

import { useState } from "react";
import {
  Unlink,
  Link,
  Fingerprint,
  AlertCircle,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
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
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  useVaultStatus,
  useVaultPair,
  useVaultDisconnect,
  type BitwardenStatusData,
} from "@/hooks/use-vault-status";

export const BitwardenSetup = () => {
  const { status, loading, isPaired, isReady, fetchStatus } =
    useVaultStatus<BitwardenStatusData>();
  const { pair, pairing } = useVaultPair(fetchStatus);
  const { disconnect, disconnecting } = useVaultDisconnect(fetchStatus);
  const [pairingCode, setPairingCode] = useState("");

  const isValidCode =
    pairingCode.includes("_") &&
    pairingCode.split("_").length === 2 &&
    pairingCode.split("_").every((part) => part.length === 64);

  const handlePair = async () => {
    const parts = pairingCode.split("_");
    const success = await pair(parts[0]!, parts[1]!);
    if (success) {
      setPairingCode("");
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isPaired) {
    const hasError = !!status?.status_data?.last_error;

    return (
      <div className="space-y-6">
        {/* Connection status card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Connection</CardTitle>
              <Badge
                variant="outline"
                className={
                  hasError
                    ? "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400"
                    : "border-brand/20 bg-brand/5 text-brand dark:border-brand/30 dark:bg-brand/10"
                }
              >
                <span
                  className={`mr-1.5 inline-block size-1.5 rounded-full ${hasError ? "bg-red-500" : "bg-brand"}`}
                />
                {hasError ? "Error" : isReady ? "Connected" : "Paired"}
              </Badge>
            </div>
            <CardDescription>
              Credentials are fetched on-demand when no matching local secrets
              are configured.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {status?.status_data?.fingerprint && (
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground flex items-center gap-1.5 text-xs font-normal">
                  <Fingerprint className="size-3" />
                  Device Fingerprint
                </Label>
                <code className="bg-muted text-muted-foreground rounded px-2 py-1.5 font-mono text-xs break-all">
                  {status.status_data.fingerprint}
                </code>
              </div>
            )}

            {status?.status_data?.last_error && (
              <div className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border border-red-200 p-3 text-sm dark:border-red-900">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <div className="grid gap-1.5">
                  <span>{status.status_data.last_error}</span>
                  <p className="text-muted-foreground text-xs">
                    Make sure{" "}
                    <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                      aac listen
                    </code>{" "}
                    is running and your Bitwarden vault is unlocked.{" "}
                    <a
                      href="https://www.onecli.sh/docs/vaults/bitwarden#troubleshooting"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2 hover:no-underline"
                    >
                      Troubleshooting
                    </a>
                  </p>
                  <button
                    onClick={fetchStatus}
                    className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs underline-offset-2 hover:underline"
                  >
                    <RefreshCw className="size-3" />
                    Refresh status
                  </button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Danger zone */}
        <Card>
          <CardHeader>
            <CardTitle>Disconnect</CardTitle>
            <CardDescription>
              Remove the pairing with your Bitwarden vault. Credentials will no
              longer be fetched on-demand. You can reconnect at any time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="w-fit" size="sm">
                  <Unlink className="size-3.5" />
                  Disconnect vault
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disconnect vault?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove the pairing with your Bitwarden vault.
                    Credentials will no longer be fetched on-demand. You can
                    reconnect at any time.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={disconnect}
                    disabled={disconnecting}
                  >
                    {disconnecting ? "Disconnecting..." : "Disconnect"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Not paired — connect form
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect Vault</CardTitle>
        <CardDescription>
          Pair your Bitwarden vault to inject credentials on-demand.{" "}
          <a
            href="https://www.onecli.sh/docs/vaults/bitwarden"
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground inline-flex items-center gap-0.5 underline underline-offset-2 hover:no-underline"
          >
            Setup guide
            <ExternalLink className="size-3" />
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="pairing-code">Pairing Code</Label>
          <Input
            id="pairing-code"
            value={pairingCode}
            onChange={(e) => setPairingCode(e.target.value)}
            placeholder="a1b2c3d4..._e5f6a7b8..."
            className="font-mono text-sm"
          />
          <p className="text-muted-foreground text-xs">
            Paste the full code from{" "}
            <code className="bg-muted rounded px-1 py-0.5 text-xs font-mono">
              aac listen --psk
            </code>
            .
          </p>
        </div>
        <Button
          onClick={handlePair}
          loading={pairing}
          disabled={!isValidCode}
          className="w-fit"
        >
          <Link className="size-3.5" />
          {pairing ? "Connecting..." : "Connect Vault"}
        </Button>
      </CardContent>
    </Card>
  );
};
