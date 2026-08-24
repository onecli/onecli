"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
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
  /** A `pending_setup` presence exists: re-running create returns fresh URLs. */
  resuming: boolean;
}

/**
 * Opens a centered, *blank* popup (the app-connect sizing) synchronously inside
 * a click — to be pointed at the install URL once the create resolves. Opening
 * it blank up front is the only way `window.open` survives a popup blocker: the
 * events-arm create round-trips through Slack's `apps.manifest.create`, so
 * `onSuccess` fires long after the click's transient activation is gone.
 * Returns `null` when the browser blocked it even here — the caller then offers
 * the URL as a plain link, whose click is a fresh gesture the blocker allows.
 */
const openInstallPopup = (): Window | null => {
  const w = 520;
  const h = 700;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
  return window.open(
    "",
    "_blank",
    `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`,
  );
};

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
  resuming,
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
    // Events arm only: the consent page opens in a popup, but `onSuccess` runs
    // after Slack's `apps.manifest.create` round-trip — too late for
    // `window.open` to count as user-initiated. So open a blank placeholder
    // now, inside the gesture, and point it at the URL when the create returns.
    // The socket "Create app" has no install URL and opens nothing.
    const popup = transport === "events" ? openInstallPopup() : null;

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
          } else if (transport === "events") {
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
        {resuming && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-sm">
              Setup was started but not finished. Pick up where it left off.
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

        {!hasOrgCredentials ? (
          <SlackManifestFloor
            agentId={agentId}
            transport={transport}
            requestedTransport={requestedTransport}
          />
        ) : attach.data?.transport === "socket" ? (
          <SlackGuidedSocketSteps
            agentId={agentId}
            settingsUrl={attach.data.settingsUrl}
          />
        ) : (
          <div className="space-y-2">
            <Button onClick={startGuided} loading={attach.isPending}>
              {attach.isPending
                ? transport === "events"
                  ? "Adding…"
                  : "Creating…"
                : resuming
                  ? "Resume setup"
                  : transport === "events"
                    ? "Add to Slack"
                    : "Create app"}
            </Button>
            <p className="text-muted-foreground text-xs">
              {transport === "events"
                ? "Creates the Slack app and opens the install page. One click, nothing to paste."
                : "Creates the Slack app from your workspace credential. Then paste two tokens to finish."}
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
        )}
      </CardContent>
    </Card>
  );
};
