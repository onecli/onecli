"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Label } from "@onecli/ui/components/label";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { SecretInput } from "@/components/secret-input";
import { AppIcon } from "@/lib/components/app-icon";
import { slack as slackApp } from "@onecli/api/apps/slack";
import { WorkspaceAvatar } from "./workspace-avatar";
import {
  useConnectChannelIntegration,
  useDisconnectChannelIntegration,
  useOrgChannels,
} from "@/hooks/use-org-channels";

/**
 * The org's Slack integration: the automation credential (an App
 * Configuration refresh token) that makes per-agent apps one-click. Rotation
 * is automatic server-side; when it fails, `needsCredentials` surfaces the
 * amber re-paste state. A workspace connected only through hand-made apps
 * (the paste floor) appears here too, with the paste form as its upgrade
 * path. Removal exists in every state: Disconnect (live credential) or
 * Remove (dead/absent credential) — the server deletes the row only when no
 * agent apps or member links reference it, so the dialog says which outcome
 * the click buys.
 */
export const SlackIntegrationCard = () => {
  const { data, isPending } = useOrgChannels();
  const connect = useConnectChannelIntegration();
  const disconnect = useDisconnectChannelIntegration();
  const [token, setToken] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const slack = data?.integrations.find((i) => i.provider === "slack");
  const showAdapterOffline =
    data !== undefined && data.integrations.length > 0 && !data.adapter.online;

  // What keeps the workspace row alive: the server deletes it only when no
  // agent apps and no member links reference it — otherwise a disconnect
  // clears the credential and the row stays listed.
  const slackLinkCount =
    data?.userLinks.filter((l) => l.integration.provider === "slack").length ??
    0;
  const referenced = (slack?.presenceCount ?? 0) > 0 || slackLinkCount > 0;
  const willDelete = !referenced;
  const usage = [
    slack && slack.presenceCount > 0
      ? `${slack.presenceCount} agent app${slack.presenceCount === 1 ? "" : "s"}`
      : null,
    slackLinkCount > 0
      ? `${slackLinkCount} member link${slackLinkCount === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" and ");
  // The one state where the DELETE would change nothing: no credential to
  // clear, no dead-token notice to resolve, and the row survives regardless.
  const removeIsNoop =
    slack !== undefined &&
    !slack.hasCredentials &&
    !slack.needsCredentials &&
    referenced;

  const hasCredentials = slack?.hasCredentials ?? false;
  const dialogDescription = [
    hasCredentials
      ? "One-click agent setup stops working. Agents already attached keep their own tokens and stay in Slack."
      : null,
    !hasCredentials && slack?.needsCredentials && !willDelete
      ? "This clears the expired credential."
      : null,
    willDelete
      ? "This removes the workspace connection from your organization."
      : `The workspace stays listed while it's still in use: ${usage}. Detach those to remove it completely.`,
  ]
    .filter(Boolean)
    .join(" ");
  const successToast = willDelete
    ? "Slack workspace removed"
    : hasCredentials
      ? "Slack disconnected"
      : "Expired credential cleared";

  const submitToken = (e: React.FormEvent) => {
    e.preventDefault();
    const credential = token.trim();
    if (!credential) return;
    connect.mutate(
      { provider: "slack", credential },
      {
        onSuccess: (result) => {
          setToken("");
          toast.success(
            `Connected ${result.tenant.name ?? result.tenant.externalId}`,
          );
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const pasteForm = (
    <form onSubmit={submitToken} className="grid gap-2">
      <Label htmlFor="slack-config-token">
        App Configuration refresh token
      </Label>
      <div className="flex max-w-lg gap-2">
        <SecretInput
          id="slack-config-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="xoxe-1-…"
          className="flex-1"
        />
        <Button
          type="submit"
          className="shrink-0"
          disabled={!token.trim() || connect.isPending}
          loading={connect.isPending}
        >
          {connect.isPending ? "Connecting…" : "Connect"}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Generate one under{" "}
        <a
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground inline-flex items-center gap-0.5 underline underline-offset-2"
        >
          api.slack.com/apps
          <ExternalLink className="size-3" />
        </a>{" "}
        → Your App Configuration Tokens. Paste the refresh token here. It
        enables one-click Slack apps for your agents and rotates automatically
        from then on.
      </p>
    </form>
  );

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="bg-card flex size-10 shrink-0 items-center justify-center rounded-xl border shadow-sm">
              <AppIcon icon={slackApp.icon} name={slackApp.name} size={22} />
            </span>
            <div className="min-w-0">
              <CardTitle>{slackApp.name}</CardTitle>
              <CardDescription>
                One workspace credential powers one-click Slack apps for every
                agent in this organization.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-9 w-full max-w-lg" />
            </div>
          ) : !slack ? (
            pasteForm
          ) : (
            <>
              {slack.needsCredentials && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm dark:border-amber-500/40 dark:bg-amber-500/15">
                  The stored token expired and could not be refreshed. Paste a
                  fresh App Configuration refresh token to restore one-click
                  setup.
                </p>
              )}
              <div className="bg-muted/40 flex items-center gap-3 rounded-lg border px-3 py-2.5">
                <WorkspaceAvatar name={slack.name ?? slack.externalId} />
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium">
                    {slack.name ?? slack.externalId}
                    <span className="text-muted-foreground ml-2 font-mono text-xs">
                      {slack.externalId}
                    </span>
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {slack.presenceCount === 1
                      ? "1 agent app"
                      : `${slack.presenceCount} agent apps`}
                    {slack.hasCredentials && slack.credentialsRotatedAt && (
                      <>
                        {" "}
                        · token rotated{" "}
                        {new Date(slack.credentialsRotatedAt).toLocaleString()}
                      </>
                    )}
                  </p>
                </div>
              </div>
              {slack.hasCredentials ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmOpen(true)}
                >
                  Disconnect
                </Button>
              ) : (
                // Connected via hand-made apps only, or the credential died —
                // either way the paste form is the way (back) to one-click,
                // and removal must not depend on holding a live credential.
                <>
                  {pasteForm}
                  {removeIsNoop ? (
                    <p className="text-muted-foreground text-sm">
                      This workspace stays listed while it&apos;s still in use:{" "}
                      {usage}. Detach those to remove it.
                    </p>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmOpen(true)}
                    >
                      Remove
                    </Button>
                  )}
                </>
              )}
            </>
          )}

          {showAdapterOffline && (
            <p className="text-sm text-amber-600 dark:text-amber-500">
              Channels are offline. The adapter hasn&apos;t reported in a while.
            </p>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {hasCredentials ? "Disconnect Slack?" : "Remove Slack workspace?"}
            </AlertDialogTitle>
            <AlertDialogDescription>{dialogDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnect.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnect.isPending}
              // Keep the dialog open across the request (Radix would close it
              // on click) and close it ourselves once the mutation resolves.
              onClick={(e) => {
                e.preventDefault();
                disconnect.mutate("slack", {
                  onSuccess: () => {
                    toast.success(successToast);
                    setConfirmOpen(false);
                  },
                  onError: (err) => toast.error(err.message),
                });
              }}
            >
              {disconnect.isPending && (
                <Loader2 className="animate-spin" aria-hidden />
              )}
              {disconnect.isPending
                ? hasCredentials
                  ? "Disconnecting…"
                  : "Removing…"
                : hasCredentials
                  ? "Disconnect"
                  : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
