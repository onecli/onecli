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
import { Badge } from "@onecli/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { AppIcon } from "@/lib/components/app-icon";
import { slack as slackApp } from "@onecli/api/apps/slack";
import {
  useDisconnectSharedInstall,
  useOrgChannels,
  useStartSharedInstall,
} from "@/hooks/use-org-channels";

export interface SlackSharedAppCardProps {
  /** Provided only in the SETUP CHOICE state (nothing connected yet). The
   * card's ROLE there decides the swap affordance's wording and placement:
   * `leading` (post-approval default face) shows a small "or connect with an
   * App Configuration token instead" under Add to Slack; `alternative`
   * (pre-approval, the token leads) shows the recommended way back under the
   * description. `onSwap` swaps the surface to the token card (the row owns
   * the swap). Absent everywhere else — the choice moment is over once
   * something is connected. */
  choice?: { role: "leading" | "alternative"; onSwap: () => void };
}

/**
 * The SHARED OneCLI Slack app: one "Add to Slack" click installs the
 * deployment's distributed app into the org's workspace. Its job is
 * ONBOARDING: any workspace member can DM the OneCLI bot and gets a button
 * that signs them up (or in) by their Slack-verified email — the low-
 * friction door for teammates to join the org. Renders nothing when the
 * deployment has no shared app configured.
 */
export const SlackSharedAppCard = ({ choice }: SlackSharedAppCardProps) => {
  const { data, isPending } = useOrgChannels();
  const start = useStartSharedInstall();
  const disconnect = useDisconnectSharedInstall();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Set only when the popup was blocked: the URL is then offered as a plain
  // link, whose click is a fresh gesture the blocker allows (the same
  // pattern as the agent attach card).
  const [blockedInstallUrl, setBlockedInstallUrl] = useState<string | null>(
    null,
  );

  // Hidden entirely while loading is resolved to "not configured" — the
  // dedicated-app card is the surface self-hosts without the env vars see.
  if (
    !isPending &&
    !data?.sharedApp?.available &&
    !data?.sharedApp?.installation
  ) {
    return null;
  }

  const installation = data?.sharedApp?.installation ?? null;

  const addToSlack = () => {
    setBlockedInstallUrl(null);
    // Open the placeholder synchronously inside the click — `onSuccess`
    // fires after the server round-trip, past the gesture window popup
    // blockers honor. No `noopener`: that feature makes `window.open`
    // answer null by spec, and the handle is what we point at the URL.
    // Same centered popup as the agent attach card, so the two install
    // doors feel identical.
    const w = 520;
    const h = 700;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
    const popup = window.open(
      "",
      "_blank",
      `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`,
    );
    start.mutate("slack", {
      onSuccess: ({ installUrl }) => {
        if (popup) {
          popup.location.href = installUrl;
        } else {
          setBlockedInstallUrl(installUrl);
          toast.error(
            "Your browser blocked the Slack window. Use the link below to continue.",
          );
        }
      },
      onError: (err) => {
        popup?.close();
        toast.error(err.message);
      },
    });
  };

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
                <CardTitle>Team onboarding</CardTitle>
                {!isPending && (
                  <Badge
                    variant={installation ? "default" : "secondary"}
                    className={
                      installation
                        ? "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400"
                        : undefined
                    }
                  >
                    {installation ? "Installed" : "Not installed"}
                  </Badge>
                )}
              </div>
              <CardDescription className="mt-1">
                Teammates message @OneCLI in Slack and get their own OneCLI
                account.
                {choice?.role === "alternative" &&
                  // Honesty while the deployment's app isn't Slack-approved
                  // yet: installing it does NOT set up agent apps — don't let
                  // the admin land here thinking it replaces the token.
                  " Agent apps are still set up with an App Configuration token."}
              </CardDescription>
              {choice?.role === "alternative" && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground -mb-1 mt-2 py-1 text-xs underline underline-offset-2"
                  onClick={choice.onSwap}
                >
                  Use an App Configuration token instead (recommended)
                </button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1">
          {isPending ? (
            <Skeleton className="h-9 w-40" />
          ) : !installation ? (
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs">
                Opens Slack&apos;s consent page. Workspaces that require admin
                approval complete automatically once approved.
              </p>
              {blockedInstallUrl && (
                <Button variant="outline" size="sm" asChild>
                  <a href={blockedInstallUrl} target="_blank" rel="noreferrer">
                    Open the Slack install page
                    <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              Anyone in{" "}
              <span className="text-foreground font-medium">
                {installation.tenant.name ?? installation.tenant.externalId}
              </span>{" "}
              can now DM the OneCLI app to get their account.
            </p>
          )}
        </CardContent>
        {!isPending && (
          <CardFooter className="justify-between border-t">
            {!installation ? (
              <div className="flex flex-col items-start gap-2.5">
                <Button
                  onClick={addToSlack}
                  disabled={start.isPending}
                  loading={start.isPending}
                >
                  {start.isPending ? "Preparing…" : "Add to Slack"}
                </Button>
                {choice?.role === "leading" && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground -my-1 py-1 text-xs underline underline-offset-2"
                    onClick={choice.onSwap}
                  >
                    or connect with an App Configuration token instead
                  </button>
                )}
              </div>
            ) : (
              <>
                <p className="text-muted-foreground min-w-0 truncate font-mono text-xs">
                  {installation.tenant.externalId}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive shrink-0"
                  onClick={() => setConfirmOpen(true)}
                >
                  Remove
                </Button>
              </>
            )}
          </CardFooter>
        )}
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the OneCLI app?</AlertDialogTitle>
            <AlertDialogDescription>
              The app is uninstalled from your Slack workspace, and teammates
              can no longer get their OneCLI account from Slack.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnect.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnect.isPending}
              onClick={(e) => {
                e.preventDefault();
                disconnect.mutate("slack", {
                  onSuccess: () => {
                    toast.success("OneCLI removed from the workspace");
                    setConfirmOpen(false);
                  },
                  onError: (err) => toast.error(err.message),
                });
              }}
            >
              {disconnect.isPending && (
                <Loader2 className="animate-spin" aria-hidden />
              )}
              {disconnect.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
