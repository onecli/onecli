"use client";

import { useState } from "react";
import {
  Shield,
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
import { Separator } from "@onecli/ui/components/separator";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  useVaultStatus,
  useVaultPair,
  useVaultDisconnect,
  type BitwardenStatusData,
} from "@/hooks/use-vault-status";

const statusBadge = (
  isReady: boolean,
  hasError: boolean,
): { className: string; dotClassName: string; label: string } => {
  if (hasError) {
    return {
      className:
        "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400",
      dotClassName: "bg-red-500",
      label: "Error",
    };
  }
  return {
    className:
      "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400",
    dotClassName: "bg-green-500",
    label: isReady ? "Connected" : "Paired",
  };
};

export const VaultAccessCard = () => {
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
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Skeleton className="h-14 w-full" />
          <Separator />
          <Skeleton className="h-8 w-28" />
        </CardContent>
      </Card>
    );
  }

  if (isPaired) {
    const badge = statusBadge(isReady, !!status?.status_data?.last_error);

    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="text-muted-foreground size-4" />
              <CardTitle>Bitwarden Vault</CardTitle>
              <Badge
                variant="secondary"
                className="text-[10px] font-normal px-1.5 py-0"
              >
                Beta
              </Badge>
            </div>
            <Badge variant="outline" className={badge.className}>
              <span
                className={`mr-1.5 inline-block size-1.5 rounded-full ${badge.dotClassName}`}
              />
              {badge.label}
            </Badge>
          </div>
          <CardDescription>
            Credentials are fetched on-demand when no matching local secrets are
            configured.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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

          <Separator />

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="w-fit" size="sm">
                <Unlink className="size-3.5" />
                Disconnect
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
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Shield className="text-muted-foreground size-4" />
          <CardTitle>Bitwarden Vault</CardTitle>
          <Badge
            variant="secondary"
            className="text-[10px] font-normal px-1.5 py-0"
          >
            Beta
          </Badge>
        </div>
        <CardDescription>
          Connect your Bitwarden vault to inject credentials on-demand without
          storing them on the server.{" "}
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
      <CardContent className="flex flex-col gap-4">
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
