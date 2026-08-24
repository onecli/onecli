"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { SecretInput } from "@/components/secret-input";
import type { ChannelTransport } from "@/lib/api";
import { useChannelManifest, useCompleteChannel } from "@/hooks/use-channels";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { InstallStep } from "@/app/(dashboard)/w/[workspaceId]/settings/install/_components/install-step";

interface SlackManifestFloorProps {
  agentId: string;
  transport: ChannelTransport;
  /** The picker's choice, sent on the wire only when the server offers one
   * (undefined on older servers, whose strict schemas reject unknown keys). */
  requestedTransport?: ChannelTransport;
}

/**
 * The paste floor: no org automation credential, so the user creates the app
 * by hand from our manifest, then pastes the tokens the chosen transport
 * needs — bot token + signing secret (events) or bot token + app-level token
 * (socket), plus the app id either way.
 */
export const SlackManifestFloor = ({
  agentId,
  transport,
  requestedTransport,
}: SlackManifestFloorProps) => {
  const manifestQuery = useChannelManifest(
    agentId,
    "slack",
    true,
    requestedTransport,
  );
  const complete = useCompleteChannel(agentId, "slack");
  const { copied, copy } = useCopyToClipboard();

  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [appId, setAppId] = useState("");

  const manifestJson = manifestQuery.data
    ? JSON.stringify(manifestQuery.data.material, null, 2)
    : null;

  const socket = transport === "socket";
  const ready =
    botToken.trim().length > 0 &&
    appId.trim().length > 0 &&
    (socket ? appToken.trim().length > 0 : signingSecret.trim().length > 0);

  const submit = () =>
    complete.mutate(
      {
        botToken: botToken.trim(),
        appId: appId.trim(),
        ...(socket
          ? { appToken: appToken.trim() }
          : { signingSecret: signingSecret.trim() }),
        ...(requestedTransport && { transport: requestedTransport }),
      },
      {
        onSuccess: () => toast.success("Slack connected"),
        onError: (err) => toast.error(err.message),
      },
    );

  return (
    <ol>
      <InstallStep
        number={1}
        title="Create a Slack app from this manifest"
        description="The manifest pre-configures everything the agent needs. Paste it as-is when Slack asks."
      >
        <div className="space-y-2">
          <Button variant="outline" size="sm" asChild>
            <a
              href="https://api.slack.com/apps?new_app=1"
              target="_blank"
              rel="noreferrer"
            >
              Create app on api.slack.com
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
          {manifestJson === null ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <div className="relative">
              <pre className="bg-muted max-h-64 overflow-auto rounded-md border p-3 pr-10 font-mono text-xs whitespace-pre-wrap break-all">
                {manifestJson}
              </pre>
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-1.5 right-1.5"
                aria-label="Copy manifest"
                onClick={() => copy(manifestJson)}
              >
                {copied ? (
                  <Check className="text-brand size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            </div>
          )}
        </div>
      </InstallStep>
      <InstallStep
        number={2}
        title="Install the app and paste its credentials"
        description="Install it to your workspace from the app's settings, then copy each value below."
        last
      >
        <div className="space-y-3">
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor="slack-floor-bot-token">Bot token</Label>
            <SecretInput
              id="slack-floor-bot-token"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="xoxb-…"
            />
            <p className="text-muted-foreground text-xs">
              OAuth &amp; Permissions → Bot User OAuth Token, after installing.
            </p>
          </div>
          {socket ? (
            <div className="grid max-w-md gap-1.5">
              <Label htmlFor="slack-floor-app-token">App-level token</Label>
              <SecretInput
                id="slack-floor-app-token"
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                placeholder="xapp-…"
              />
              <p className="text-muted-foreground text-xs">
                Basic Information → App-Level Tokens. Create one with the
                connections:write scope.
              </p>
            </div>
          ) : (
            <div className="grid max-w-md gap-1.5">
              <Label htmlFor="slack-floor-signing-secret">Signing secret</Label>
              <SecretInput
                id="slack-floor-signing-secret"
                value={signingSecret}
                onChange={(e) => setSigningSecret(e.target.value)}
                placeholder="Signing secret"
              />
              <p className="text-muted-foreground text-xs">
                Basic Information → App Credentials → Signing Secret.
              </p>
            </div>
          )}
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor="slack-floor-app-id">App ID</Label>
            <Input
              id="slack-floor-app-id"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder="A0123ABCDEF"
              className="font-mono text-sm"
            />
            <p className="text-muted-foreground text-xs">
              Basic Information → App ID.
            </p>
          </div>
          <Button
            onClick={submit}
            disabled={!ready || complete.isPending}
            loading={complete.isPending}
          >
            {complete.isPending ? "Connecting…" : "Finish setup"}
          </Button>
        </div>
      </InstallStep>
    </ol>
  );
};
