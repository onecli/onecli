"use client";

import { useState } from "react";
import Image from "next/image";
import { CircleCheck, ExternalLink } from "lucide-react";
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
  /** The one-click consent URL, when this app can install by OAuth (created
   * on a public HTTPS origin, not installed yet). */
  installUrl: string | null;
  /** The OAuth install already landed: the bot token is held server-side
   * and only the app-level token is left. */
  installed: boolean;
}

/**
 * The socket arm's completion. Socket Mode needs an app-level token (`xapp-`)
 * that Slack only mints by hand, so one paste is unavoidable. Everything
 * else is automated where the deployment allows it: with a public HTTPS
 * origin the app installs with one Allow click (OAuth), and the paste is the
 * only manual step left. Without one (a plain localhost self-host), Slack
 * refuses the redirect and the bot token is pasted too.
 */
export const SlackGuidedSocketSteps = ({
  agentId,
  settingsUrl,
  installUrl,
  installed,
}: SlackGuidedSocketStepsProps) => {
  const complete = useCompleteChannel(agentId, "slack");
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const oneClick = installed || installUrl !== null;

  const submit = () =>
    complete.mutate(
      oneClick
        ? { appToken: appToken.trim() }
        : { botToken: botToken.trim(), appToken: appToken.trim() },
      {
        onSuccess: () => toast.success("Slack connected"),
        onError: (err) => toast.error(err.message),
      },
    );

  const appTokenField = (
    <div className="space-y-3">
      <Button variant="outline" size="sm" asChild>
        <a href={settingsUrl} target="_blank" rel="noreferrer">
          Open app settings
          <ExternalLink className="size-3.5" />
        </a>
      </Button>
      {/* Where the button lives on Slack's page: users kept landing on the
          wrong token section (live, 2026-10-08). */}
      <Image
        src="/slack-app-level-token.png"
        alt="Slack app settings, Basic Information page: the App-Level Tokens section with the Generate Token and Scopes button highlighted"
        width={1100}
        height={779}
        sizes="(min-width: 768px) 448px, 100vw"
        className="w-full max-w-md rounded-md border"
      />
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
  );

  if (oneClick) {
    return (
      <ol>
        <InstallStep
          number={1}
          title="Install the app in Slack"
          description={
            installed
              ? "Installed. The bot token is saved."
              : "One click: review the permissions and choose Allow."
          }
        >
          {installed ? (
            <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
              <CircleCheck className="size-4" aria-hidden />
              Installed in Slack
            </p>
          ) : (
            installUrl && (
              <Button size="sm" asChild>
                <a href={installUrl} target="_blank" rel="noreferrer">
                  Allow in Slack
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            )
          )}
        </InstallStep>
        <InstallStep
          number={2}
          title="Paste the app-level token"
          description="Slack only creates this token by hand. In app settings, scroll to App-Level Tokens and choose Generate Token and Scopes. Add the connections:write scope, generate, then copy the xapp- token. Leave Token rotation off: rotating tokens expire after 12 hours."
          last
        >
          <div className="space-y-3">
            {appTokenField}
            <Button
              onClick={submit}
              disabled={!installed || !appToken.trim() || complete.isPending}
              loading={complete.isPending}
            >
              {complete.isPending ? "Connecting…" : "Finish setup"}
            </Button>
            {!installed && (
              <p className="text-muted-foreground text-xs">
                Finish step 1 first.
              </p>
            )}
          </div>
        </InstallStep>
      </ol>
    );
  }

  return (
    <ol>
      <InstallStep
        number={1}
        title="Generate an app-level token"
        description="App settings → Basic Information → App-Level Tokens. Create one with the connections:write scope, and leave Token rotation off."
      >
        {appTokenField}
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
