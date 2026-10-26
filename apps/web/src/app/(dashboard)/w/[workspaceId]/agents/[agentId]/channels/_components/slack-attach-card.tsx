"use client";

import Link from "next/link";
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { AppIcon } from "@/lib/components/app-icon";
import {
  SLACK_DISPLAY_NAME,
  SLACK_ICON_SRC,
  slackAppSettingsUrl,
} from "@/lib/agents/slack-presence";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import type { ChannelTransport } from "@/lib/api";
import { useAttachChannel, useDetachChannel } from "@/hooks/use-channels";
import { openInstallPopup } from "@/lib/agents/install-popup";
import { SlackDetachDialog } from "./slack-detach-dialog";
import { SlackGuidedSocketSteps } from "./slack-guided-socket-steps";
import { SlackManifestFloor } from "./slack-manifest-floor";
import { SlackTransportPicker } from "./slack-transport-picker";

interface SlackAttachCardProps {
  agentId: string;
  /** The deployment's transport posture: the default and (on servers that
   * offer a choice) the alternatives. */
  posture: { transport: ChannelTransport; available?: ChannelTransport[] };
  /** A pending presence resumes on ITS stamped transport. */
  pendingTransport?: ChannelTransport;
  hasOrgCredentials: boolean;
  /** Where "connect Slack for your organization" points. */
  organizationId: string;
  /** Whether the caller may OPEN that page (it's admin-gated): members get
   * "ask an admin" copy instead of a link that silently bounces them. */
  viewerIsOrgAdmin: boolean;
  /** A `pending_setup` presence exists: re-running create returns fresh URLs. */
  resuming: boolean;
  /**
   * The presence is `disabled`: the workspace REMOVED the app on the Slack
   * side (uninstalled it, or revoked its token). Same resume mechanics as
   * `resuming` (the row keeps its app id and client credentials), different
   * story: the copy says what happened and offers re-attach or detach.
   */
  removed?: boolean;
  /** The bot's handle, for the removed copy ("@donna"), where known. */
  identityName?: string | null;
  /**
   * The resumable app's own id (`A0…`): a detached or half-finished setup,
   * or an app removed on the Slack side. The manual floor uses it to
   * re-attach THAT app: no "create a new app" step, no App ID field to
   * retype. Null when there is nothing to resume.
   */
  resumeAppId?: string | null;
  /** The resumable socket app was installed by consent and waits only for
   * its app-level token (server-decided). */
  awaitingTransportCredential?: boolean;
}

/**
 * The unattached (and resume) face of the Slack card. Three arms, decided by
 * what the org holds and how events can reach us: one-click install (events +
 * org credential), guided create + token paste (socket + org credential), or
 * the manifest paste floor (no org credential at all). When the deployment
 * can serve both transports, a mode picker sits above the arms — the mode is
 * baked into the Slack app at create time, so it is chosen up front.
 */
export const SlackAttachCard = ({
  agentId,
  posture,
  pendingTransport,
  hasOrgCredentials,
  organizationId,
  viewerIsOrgAdmin,
  resuming,
  removed = false,
  identityName = null,
  resumeAppId = null,
  awaitingTransportCredential = false,
}: SlackAttachCardProps) => {
  const attach = useAttachChannel(agentId, "slack");
  const detach = useDetachChannel(agentId, "slack");
  const [picked, setPicked] = useState<ChannelTransport>(
    pendingTransport ?? posture.transport,
  );
  // Set only when the events-arm popup was blocked despite opening inside the
  // click: the install URL is then offered as a plain link, whose click is a
  // fresh user gesture the blocker won't eat.
  const [blockedInstallUrl, setBlockedInstallUrl] = useState<string | null>(
    null,
  );
  // The removed face's Detach is a real teardown of a real (if dead) app, so
  // it takes the same confirmation the attached face's Detach does — never
  // an immediate click (the destructive-action rule).
  const [detachOpen, setDetachOpen] = useState(false);

  // The picker renders only when the server offers a real choice (older
  // servers send no `available`) and nothing is pinned by a pending row.
  const showPicker = (posture.available?.length ?? 1) > 1 && !resuming;
  // A resume is pinned to the row's stamp; a fresh attach follows the picker.
  const transport = resuming && pendingTransport ? pendingTransport : picked;
  // The wire carries the EFFECTIVE transport whenever the server understands
  // it (`available` present) — including a resume, so the floor's manifest is
  // fetched for the row's stamp, not the drifted deployment default. Older
  // servers get nothing: the old attach route reads no body (the choice would
  // be silently ignored) and the old strict complete schema rejects the key.
  const requestedTransport = posture.available ? transport : undefined;
  // A socket app can install by consent where the server can also serve
  // webhooks: both need the same public HTTPS origin (Slack's redirect rule).
  const canInstallSocket =
    transport === "socket" && (posture.available?.includes("events") ?? false);
  // No org credential splits two ways (the render below): the events posture
  // points at the org setup, the socket posture falls to the manual paste
  // floor. Named once so the resume hint and the arm shown never disagree.
  const needsOrgSetup = !hasOrgCredentials && transport === "events";
  const onPasteFloor = !hasOrgCredentials && !needsOrgSetup;
  // Installed by consent, one paste left. Needs no org credential: the app
  // exists and holds its bot token, so this arm wins over the paste floor.
  const awaitingAppId =
    resuming && awaitingTransportCredential ? resumeAppId : null;

  const pickTransport = (next: ChannelTransport) => {
    setPicked(next);
    // A create result belongs to the mode it was made for — a stale one must
    // not drop the user into the other mode's steps.
    attach.reset();
    setBlockedInstallUrl(null);
  };

  const startOver = () => {
    detach.mutate(
      { deleteRemote: true },
      {
        onSuccess: () => {
          // The dead app's URLs must not survive into the next attempt —
          // neither the create result nor the blocked-popup fallback link.
          attach.reset();
          setBlockedInstallUrl(null);
          toast.success("Setup cleared.");
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const startGuided = () => {
    setBlockedInstallUrl(null);
    // The consent page opens in a popup, but `onSuccess` runs after Slack's
    // `apps.manifest.create` round-trip, too late for `window.open` to count
    // as user-initiated. So open a blank placeholder now, inside the
    // gesture, and point it at the URL when the create returns. Socket gets
    // one too when the deployment can install it by consent (a public HTTPS
    // origin); otherwise its create returns no URL and the popup closes.
    const popup =
      transport === "events" || canInstallSocket ? openInstallPopup() : null;

    attach.mutate(
      requestedTransport ? { transport: requestedTransport } : undefined,
      {
        onSuccess: (result) => {
          if (!result.installUrl) {
            popup?.close();
            return;
          }
          if (popup) {
            popup.location.href = result.installUrl;
          } else {
            // Blocked despite the in-gesture open — fall back to a link.
            setBlockedInstallUrl(result.installUrl);
            toast.error(
              "Your browser blocked the Slack popup. Use the link below to continue.",
            );
          }
        },
        // The 422 ("no automation token") and friends carry a server sentence.
        onError: (err) => {
          popup?.close();
          toast.error(err.message);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Slack</CardTitle>
        <CardDescription>
          Put this agent in your Slack workspace: message it directly, mention
          it in channels, and approve its requests without leaving Slack.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {removed && (
          <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 dark:border-amber-500/40 dark:bg-amber-500/15">
            <p className="text-sm">
              {identityName ? `@${identityName}` : "This agent's Slack app"} was
              removed from the workspace: it was uninstalled, or its token was
              revoked. Messaging is paused and the agent knows it.
            </p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs">
                Re-attach restores the same app. Detach removes it from this
                agent.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDetachOpen(true)}
              >
                Detach
              </Button>
            </div>
          </div>
        )}
        {removed && (
          <SlackDetachDialog
            agentId={agentId}
            open={detachOpen}
            onOpenChange={setDetachOpen}
            // The app is already gone from Slack; the record delete is the
            // only remote act left, and it needs the org credential like
            // every remote delete.
            canDeleteRemote={hasOrgCredentials}
            identityName={identityName}
          />
        )}
        {resuming && !removed && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Slack never tells us a request is waiting on an admin, so the
                guided hint names that case instead of claiming to know. The
                floor and the waiting install have no Resume button: the form
                below IS the resume. */}
            <p className="text-muted-foreground text-sm">
              {awaitingAppId
                ? "Installed in Slack. Paste the app-level token below to finish, or start over to use a different app."
                : onPasteFloor
                  ? "Not connected. Paste the app's tokens below to reconnect it, or start over to use a different app."
                  : "Not finished yet. If your Slack admin has to approve the app, click Resume setup once they do."}
            </p>
            {/* The escape hatch: without it a half-finished setup pins the
                agent to its stamped transport forever (posture changes and
                abandoned installs both need a clean restart). */}
            <Button
              variant="outline"
              size="sm"
              loading={detach.isPending}
              onClick={startOver}
            >
              {detach.isPending ? "Clearing…" : "Start over"}
            </Button>
          </div>
        )}

        {showPicker && (
          <SlackTransportPicker value={picked} onValueChange={pickTransport} />
        )}

        {/* No org credential + events posture: the fix lives at the ORG
            level (one token paste powers every agent), so point there
            instead of dumping the manual manifest floor on this page. The
            socket posture keeps the floor — its manual steps are physically
            unavoidable (Slack has no API for app-level tokens), and the org
            token alone cannot finish a socket install. */}
        {needsOrgSetup ? (
          <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed px-6 py-10 text-center">
            <span className="bg-card mb-2 flex size-12 items-center justify-center rounded-2xl border shadow-sm">
              <AppIcon
                icon={SLACK_ICON_SRC}
                name={SLACK_DISPLAY_NAME}
                size={26}
              />
            </span>
            <p className="text-sm font-medium">
              Connect Slack for your organization first
            </p>
            <p className="text-muted-foreground max-w-sm text-sm">
              One admin does it once. After that, every agent joins Slack in one
              click.
            </p>
            {viewerIsOrgAdmin ? (
              <Button size="sm" className="mt-3" asChild>
                <Link href={`/org/${organizationId}/channels`}>
                  Set up Slack for the organization
                </Link>
              </Button>
            ) : (
              // The org Channels page is admin-gated and would silently
              // bounce a member — name the ask instead of a dead link.
              <p className="text-muted-foreground mt-3 max-w-sm text-sm">
                Ask an organization admin to connect Slack in the
                organization&apos;s Channels settings.
              </p>
            )}
          </div>
        ) : awaitingAppId ? (
          // The one manual step Slack leaves after the consent. The settings
          // link is rebuilt from the app id, so a reload never strands it.
          <SlackGuidedSocketSteps
            agentId={agentId}
            settingsUrl={slackAppSettingsUrl(awaitingAppId)}
            installUrl={null}
            installed
          />
        ) : onPasteFloor ? (
          // Reachable only on the SOCKET posture — the events posture routed
          // to the org-setup pointer above. The floor keeps its events arm
          // for generality; unused from here by design.
          <SlackManifestFloor
            agentId={agentId}
            transport={transport}
            requestedTransport={requestedTransport}
            reattachAppId={resuming ? resumeAppId : null}
          />
        ) : attach.data?.transport === "socket" ? (
          <SlackGuidedSocketSteps
            agentId={agentId}
            settingsUrl={attach.data.settingsUrl}
            installUrl={attach.data.installUrl}
            installed={false}
          />
        ) : (
          <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed px-6 py-10 text-center">
            <span className="bg-card mb-2 flex size-12 items-center justify-center rounded-2xl border shadow-sm">
              <AppIcon
                icon={SLACK_ICON_SRC}
                name={SLACK_DISPLAY_NAME}
                size={26}
              />
            </span>
            <p className="text-sm font-medium">
              {removed
                ? "Re-attach to Slack"
                : resuming
                  ? "Finish adding to Slack"
                  : "Not in Slack yet"}
            </p>
            <p className="text-muted-foreground max-w-sm text-sm">
              {transport === "events"
                ? "One click creates the app and opens the install page. Nothing to paste."
                : canInstallSocket
                  ? "One click creates the app and opens the install page. Then paste one token to finish."
                  : "Creates the Slack app from your workspace credential. Then paste two tokens to finish."}
            </p>
            <Button
              size="sm"
              className="mt-3"
              onClick={startGuided}
              loading={attach.isPending}
            >
              {attach.isPending
                ? transport === "events" || canInstallSocket
                  ? "Adding…"
                  : "Creating…"
                : removed
                  ? "Re-attach"
                  : resuming
                    ? "Resume setup"
                    : transport === "events" || canInstallSocket
                      ? "Add to Slack"
                      : "Create app"}
            </Button>
            {blockedInstallUrl && (
              <Button variant="outline" size="sm" className="mt-1" asChild>
                <a href={blockedInstallUrl} target="_blank" rel="noreferrer">
                  Open the Slack install page
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
