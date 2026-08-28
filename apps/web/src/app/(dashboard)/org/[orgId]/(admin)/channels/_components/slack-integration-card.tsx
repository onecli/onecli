"use client";

import { useEffect, useRef, useState } from "react";
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
import { Badge } from "@onecli/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Label } from "@onecli/ui/components/label";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { SecretInput } from "@/components/secret-input";
import { AppIcon } from "@/lib/components/app-icon";
import { slack as slackApp } from "@onecli/api/apps/slack";
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
 * path. While the shared install's user token mints agent apps
 * (`canMintAgentApps`), the paste becomes optional and folds behind a small
 * disclosure instead of leading. Removal exists in every state: Disconnect
 * (live credential) or Remove (dead/absent credential) — the server deletes
 * the row only when no agent apps or member links reference it, so the
 * dialog says which outcome the click buys.
 */
export interface SlackIntegrationCardProps {
  /** Provided only in the SETUP CHOICE state (nothing connected yet). The
   * card's ROLE there decides the swap affordance's wording and placement:
   * `leading` (pre-approval default face — the OneCLI app can't mint agent
   * apps yet) shows a small "or add the OneCLI app for team onboarding"
   * under the paste form; `alternative` (post-approval, the OneCLI app
   * leads) shows the when-you'd-pick-this framing plus the recommended way
   * back under the description. `onSwap` swaps the surface to the OneCLI app
   * card (the row owns the swap). Absent everywhere else. */
  choice?: { role: "leading" | "alternative"; onSwap: () => void };
}

export const SlackIntegrationCard = ({ choice }: SlackIntegrationCardProps) => {
  const { data, isPending } = useOrgChannels();
  const connect = useConnectChannelIntegration();
  const disconnect = useDisconnectChannelIntegration();
  const [token, setToken] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The config-token paste, folded away while the shared install already
  // mints agent apps — kept reachable as the RARE fallback path (same fold
  // pattern as the manual member link on this page). Opening/closing the
  // fold unmounts the control that had focus, so focus is handed off by
  // hand: into the input on open, back to the disclosure on Cancel.
  const [pasteOpen, setPasteOpen] = useState(false);
  const pasteDisclosureRef = useRef<HTMLButtonElement>(null);
  const restoreDisclosureFocus = useRef(false);
  useEffect(() => {
    if (pasteOpen || !restoreDisclosureFocus.current) return;
    restoreDisclosureFocus.current = false;
    pasteDisclosureRef.current?.focus();
  }, [pasteOpen]);

  const slack = data?.integrations.find((i) => i.provider === "slack");
  const showAdapterOffline =
    data !== undefined && data.integrations.length > 0 && !data.adapter.online;

  // The shared install's user token already mints agent apps: the paste is
  // optional, not required. The card stays (it owns the adapter-offline
  // notice and the removal affordances) — only the paste form folds away.
  // Double-guarded: `sharedApp` is absent on servers predating this feature.
  const mintsViaShared = data?.sharedApp?.canMintAgentApps ?? false;

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
          setPasteOpen(false);
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
          // Focus hand-off: when the fold opened this form, the disclosure
          // button that had focus just unmounted.
          autoFocus={pasteOpen}
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
        Generate one at{" "}
        <a
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground inline-flex items-center gap-0.5 underline underline-offset-2"
        >
          api.slack.com/apps
          <ExternalLink className="size-3" />
        </a>{" "}
        → Your App Configuration Tokens, and paste it once. It rotates
        automatically from then on.
      </p>
    </form>
  );

  return (
    <>
      <Card className="flex h-full flex-col">
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="bg-card flex size-10 shrink-0 items-center justify-center rounded-xl border shadow-sm">
              <AppIcon icon={slackApp.icon} name={slackApp.name} size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Agent apps</CardTitle>
                {!isPending && slack && (
                  <Badge
                    variant={
                      slack.hasCredentials || mintsViaShared
                        ? "default"
                        : "secondary"
                    }
                    className={
                      slack.hasCredentials || mintsViaShared
                        ? "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400"
                        : undefined
                    }
                  >
                    {slack.hasCredentials || mintsViaShared
                      ? "Connected"
                      : "Token needed"}
                  </Badge>
                )}
              </div>
              <CardDescription className="mt-1">
                {choice?.role === "alternative"
                  ? "For workspaces that can't install the OneCLI app. Each agent gets its own Slack app, created in one click."
                  : "Each agent gets its own Slack app, created in one click."}
              </CardDescription>
              {choice?.role === "alternative" && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground -mb-1 mt-2 py-1 text-xs underline underline-offset-2"
                  onClick={choice.onSwap}
                >
                  Use the OneCLI Slack app instead (recommended)
                </button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1">
          {isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-9 w-full max-w-lg" />
            </div>
          ) : !slack ? (
            <div className="space-y-2.5">
              {pasteForm}
              {choice?.role === "leading" && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground -my-1 py-1 text-xs underline underline-offset-2"
                  onClick={choice.onSwap}
                >
                  or add the OneCLI app so teammates can join from Slack
                </button>
              )}
            </div>
          ) : (
            <>
              {slack.needsCredentials && !mintsViaShared && (
                <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm dark:border-amber-500/40 dark:bg-amber-500/15">
                  The stored token expired and could not be refreshed. Paste a
                  fresh App Configuration refresh token to restore one-click
                  setup.
                </p>
              )}
              {slack.hasCredentials ? (
                <p className="text-muted-foreground text-sm">
                  <span className="text-foreground font-medium">
                    {slack.name ?? slack.externalId}
                  </span>{" "}
                  is connected with{" "}
                  {slack.presenceCount === 1
                    ? "1 agent app"
                    : `${slack.presenceCount} agent apps`}
                  .
                </p>
              ) : mintsViaShared ? (
                // The shared install's user token does the minting; the
                // config-token paste stays reachable as a small fallback.
                <div className="space-y-3">
                  <p className="text-muted-foreground text-sm">
                    Agent apps are created through the shared OneCLI app. No
                    configuration token needed.
                  </p>
                  {pasteOpen ? (
                    <div className="space-y-2">
                      {pasteForm}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          restoreDisclosureFocus.current = true;
                          setPasteOpen(false);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <button
                      ref={pasteDisclosureRef}
                      type="button"
                      className="text-muted-foreground hover:text-foreground -my-1 py-1 text-xs underline underline-offset-2"
                      onClick={() => setPasteOpen(true)}
                    >
                      or paste an App Configuration token instead
                    </button>
                  )}
                </div>
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
            <p className="mt-3 text-sm text-amber-600 dark:text-amber-500">
              Channels are offline. The adapter hasn&apos;t reported in a while.
            </p>
          )}
        </CardContent>
        {!isPending && slack?.hasCredentials && (
          <CardFooter className="justify-between border-t">
            <p className="text-muted-foreground min-w-0 truncate font-mono text-xs">
              {slack.externalId}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive shrink-0"
              onClick={() => setConfirmOpen(true)}
            >
              Disconnect
            </Button>
          </CardFooter>
        )}
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
