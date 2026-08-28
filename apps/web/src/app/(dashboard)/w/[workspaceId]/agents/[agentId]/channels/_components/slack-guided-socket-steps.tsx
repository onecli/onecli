"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Label } from "@onecli/ui/components/label";
import { SecretInput } from "@/components/secret-input";
import { useCompleteChannel } from "@/hooks/use-channels";
import { InstallStep } from "@/app/(dashboard)/w/[workspaceId]/settings/install/_components/install-step";

interface SlackGuidedSocketStepsProps {
  agentId: string;
  /** Where the app-level token is generated + Install lives (fresh from the
   * create call). */
  settingsUrl: string;
}

/**
 * The socket arm's completion: the app already exists (guided create), but
 * Socket Mode needs two tokens only a human can mint on Slack's side — the
 * app-level token and, after installing, the bot token.
 */
export const SlackGuidedSocketSteps = ({
  agentId,
  settingsUrl,
}: SlackGuidedSocketStepsProps) => {
  const complete = useCompleteChannel(agentId, "slack");
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");

  const submit = () =>
    complete.mutate(
      { botToken: botToken.trim(), appToken: appToken.trim() },
      {
        onSuccess: () => toast.success("Slack connected"),
        onError: (err) => toast.error(err.message),
      },
    );

  return (
    <ol>
      <InstallStep
        number={1}
        title="Generate an app-level token"
        description="App settings → Basic Information → App-Level Tokens. Create one with the connections:write scope."
      >
        <div className="space-y-2">
          <Button variant="outline" size="sm" asChild>
            <a href={settingsUrl} target="_blank" rel="noreferrer">
              Open app settings
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor="slack-app-token">App-level token</Label>
            <SecretInput
              id="slack-app-token"
              value={appToken}
              onChange={(e) => setAppToken(e.target.value)}
              placeholder="xapp-…"
            />
          </div>
        </div>
      </InstallStep>
      <InstallStep
        number={2}
        title="Install the app and paste the bot token"
        description="App settings → Install App → Install to Workspace, then copy the Bot User OAuth Token."
        last
      >
        <div className="space-y-3">
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor="slack-bot-token">Bot token</Label>
            <SecretInput
              id="slack-bot-token"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="xoxb-…"
            />
          </div>
          <Button
            onClick={submit}
            disabled={
              !appToken.trim() || !botToken.trim() || complete.isPending
            }
            loading={complete.isPending}
          >
            {complete.isPending ? "Connecting…" : "Finish setup"}
          </Button>
        </div>
      </InstallStep>
    </ol>
  );
};
