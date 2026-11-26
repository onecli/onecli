"use client";

import { useState, type ReactNode } from "react";
import {
  Unlink,
  Link as LinkIcon,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  Clock,
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
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import { SecretInput } from "@/components/secret-input";
import {
  useVaultStatus,
  useVaultDisconnect,
  type KeeperSecurityStatusData,
} from "@/hooks/use-vault-status";
import {
  useKeeperSecurityPair,
  type KeeperSecurityPairMethod,
} from "@/hooks/use-keepersecurity";
import {
  expiryNotice,
  vaultStatusBadge,
  type StatusTone,
} from "@/lib/vault-status-badge";

/** What the form shows for each connection method. Order = dropdown order. */
const PAIR_METHODS: {
  value: KeeperSecurityPairMethod;
  option: string;
  label: string;
  placeholder: string;
  help: string;
}[] = [
  {
    value: "one_time_token",
    option: "One-time access token",
    label: "One-time access token",
    placeholder: "Paste your one-time access token",
    help: "A Secrets Manager configuration as a one-time access token. The token is used once; only the resulting configuration is stored, encrypted.",
  },
  {
    value: "base64_config",
    option: "Base64 string",
    label: "Base64 configuration",
    placeholder: "Paste your base64 configuration",
    help: "A Secrets Manager configuration as a base64 string. It is stored encrypted.",
  },
  {
    value: "json_config",
    option: "JSON configuration",
    label: "JSON configuration",
    placeholder: "Paste your JSON configuration",
    help: "A Secrets Manager configuration as JSON. It is stored encrypted.",
  },
];

const BADGE_TONE: Record<StatusTone, string> = {
  ok: "border-brand/20 bg-brand/5 text-brand dark:border-brand/30 dark:bg-brand/10",
  warn: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400",
  error:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400",
};

const DOT_TONE: Record<StatusTone, string> = {
  ok: "bg-brand",
  warn: "bg-amber-500",
  error: "bg-red-500",
};

const NOTICE_TONE: Record<StatusTone, string> = {
  ok: "text-muted-foreground border-border",
  warn: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  error:
    "bg-destructive/10 text-destructive border-red-200 dark:border-red-900",
};

const NOTICE_ICON: Record<StatusTone, typeof AlertCircle> = {
  ok: Clock,
  warn: AlertTriangle,
  error: AlertCircle,
};

const Notice = ({
  tone,
  children,
  onRefresh,
}: {
  tone: StatusTone;
  children: ReactNode;
  onRefresh?: () => void;
}) => {
  const Icon = NOTICE_ICON[tone];
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border p-3 text-sm",
        NOTICE_TONE[tone],
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="grid gap-1.5">
        <div>{children}</div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs underline-offset-2 hover:underline"
          >
            <RefreshCw className="size-3" />
            Refresh status
          </button>
        )}
      </div>
    </div>
  );
};

/** Method dropdown + credential field + submit. */
const ConnectForm = ({
  fetchStatus,
  submitLabel,
}: {
  fetchStatus: () => Promise<void>;
  submitLabel: string;
}) => {
  const { pair, pairing } = useKeeperSecurityPair(fetchStatus);
  const [method, setMethod] =
    useState<KeeperSecurityPairMethod>("one_time_token");
  const [input, setInput] = useState("");
  const selected =
    PAIR_METHODS.find((m) => m.value === method) ?? PAIR_METHODS[0]!;

  const handlePair = async () => {
    const success = await pair(method, input);
    if (success) setInput("");
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <Label htmlFor="keepersecurity-method">Configuration method</Label>
        <Select
          value={method}
          onValueChange={(v) => setMethod(v as KeeperSecurityPairMethod)}
        >
          <SelectTrigger id="keepersecurity-method" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAIR_METHODS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="keepersecurity-input">{selected.label}</Label>
        <SecretInput
          id="keepersecurity-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={selected.placeholder}
        />
        <p className="text-muted-foreground text-xs">{selected.help}</p>
      </div>
      <Button
        onClick={handlePair}
        loading={pairing}
        disabled={!input.trim()}
        className="w-fit"
      >
        <LinkIcon className="size-3.5" />
        {pairing ? "Connecting..." : submitLabel}
      </Button>
    </div>
  );
};

export const KeeperSecuritySetup = () => {
  const { status, loading, isPaired, isReady, fetchStatus } =
    useVaultStatus<KeeperSecurityStatusData>("keepersecurity", {
      autoRefresh: true,
    });
  const { disconnect, disconnecting } = useVaultDisconnect(
    fetchStatus,
    "keepersecurity",
  );

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
    const data = status?.status_data;
    const lastError = data?.last_error ?? null;
    const reason = data?.reason ?? null;
    // Every way OneCLI can fail to use the connection reads the same: it can't
    // tell expiry from revocation from an outage, and the next step is the
    // same. `!!lastError` also covers gateways that predate `reason`.
    const cannotConnect = reason === "connection_failed" || !!lastError;
    const badge = vaultStatusBadge({ lastError, reason, isReady });
    const expiry = expiryNotice(data?.expires_on);
    const warnings = data?.warnings ?? [];
    const resolveError = data?.resolve_error ?? null;
    const hasNotices =
      cannotConnect ||
      reason === "no_records" ||
      !!expiry ||
      warnings.length > 0 ||
      !!resolveError;

    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Connection</CardTitle>
              <Badge variant="outline" className={BADGE_TONE[badge.tone]}>
                <span
                  className={`mr-1.5 inline-block size-1.5 rounded-full ${DOT_TONE[badge.tone]}`}
                />
                {badge.label}
              </Badge>
            </div>
            <CardDescription>
              When adding a secret, pick Keeper Security as its value source and
              choose a record field, or enter a <code>keeper://</code>{" "}
              reference. OneCLI fetches the value from Keeper when a request
              needs it. Only the reference and this connection&apos;s encrypted
              configuration are stored; the secret value is never saved.
            </CardDescription>
          </CardHeader>
          {hasNotices && (
            <CardContent className="space-y-3">
              {cannotConnect && (
                <Notice tone="error" onRefresh={fetchStatus}>
                  <p>
                    The Secrets Manager configuration may have expired or been
                    revoked, or Keeper may be unreachable from the OneCLI
                    server. If the problem persists, disconnect below and
                    connect again with a new configuration.
                  </p>
                  {lastError && (
                    <p className="mt-1 break-words text-xs opacity-80">
                      Details: {lastError}
                    </p>
                  )}
                </Notice>
              )}
              {!cannotConnect && reason === "no_records" && (
                <Notice tone="warn" onRefresh={fetchStatus}>
                  Keeper reports no records shared with OneCLI&apos;s Secrets
                  Manager application, so no Keeper secret can resolve. If
                  records were shared before, their shares were removed or have
                  expired. Share the records with the application in Keeper,
                  then refresh.
                </Notice>
              )}
              {expiry && <Notice tone={expiry.tone}>{expiry.text}</Notice>}
              {warnings.map((w) => (
                <Notice key={w} tone="warn">
                  Keeper: {w}
                </Notice>
              ))}
              {resolveError && !cannotConnect && (
                <Notice tone="warn">
                  An agent request could not resolve{" "}
                  <code className="break-all">{resolveError.ref}</code>:{" "}
                  {resolveError.message}. Check that the record is still shared
                  with the application and the field still exists.
                </Notice>
              )}
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Disconnect</CardTitle>
            <CardDescription>
              Remove the connection to Keeper. Secrets that source their value
              from Keeper will stop resolving until you reconnect.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="w-fit" size="sm">
                  <Unlink className="size-3.5" />
                  Disconnect
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disconnect Keeper?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes the stored Keeper configuration. Secrets will
                    no longer be resolved until you reconnect.
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect Keeper Security</CardTitle>
        <CardDescription>
          Connect with a one-time access token or an existing Secrets Manager
          configuration to resolve secrets on-demand.{" "}
          {/* TODO: Add a link of keepersecurity onecli gitbook docs link below */}
          <a
            href="https://docs.keeper.io/keeperpam/secrets-manager/integrations/onecli-external-vault"
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground inline-flex items-center gap-0.5 underline underline-offset-2 hover:no-underline"
          >
            Setup guide
            <ExternalLink className="size-3" />
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ConnectForm
          fetchStatus={fetchStatus}
          submitLabel="Connect Keeper Security"
        />
      </CardContent>
    </Card>
  );
};
