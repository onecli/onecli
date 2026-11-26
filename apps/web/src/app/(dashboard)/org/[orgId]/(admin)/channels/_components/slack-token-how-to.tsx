"use client";

import Image from "next/image";
import { ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@onecli/ui/components/dialog";

/**
 * Where a Slack App Configuration refresh token comes from, for the paste
 * field on the org Slack card.
 *
 * Slack's "Your App Configuration Tokens" table puts two identical Copy
 * buttons side by side (Access Token, Refresh Token), and a single prose hint
 * under the field was not enough: people still pasted the Access Token (the
 * server refuses it by name, but only after the fact). The walkthrough that
 * prevents it needs a picture of that row, and the picture plus three steps
 * is too tall for the stacked `max-w-lg` form, so the full version lives
 * behind a "How do I get this?" dialog. Only step 1 (where to go) stays
 * inline: `slackTokenOpenStep`, shared with the dialog so the wording cannot
 * drift.
 *
 * Everything here is static, so it is built once at module scope rather than
 * on every render of the card.
 */

const slackAppsLink = (
  <a
    href="https://api.slack.com/apps"
    target="_blank"
    rel="noreferrer"
    className="text-foreground inline-flex items-center gap-0.5 underline underline-offset-2"
  >
    api.slack.com/apps
    <ExternalLink className="size-3" />
  </a>
);

/** Step 1 of the walkthrough: the inline hint under the paste field. */
export const slackTokenOpenStep = (
  <>
    Open {slackAppsLink} and scroll to{" "}
    <span className="font-medium">Your App Configuration Tokens</span>.
  </>
);

/**
 * The "How do I get this?" trigger and its dialog: the three steps on Slack's
 * page plus a screenshot of the tokens row with the arrow on the Refresh
 * Token's Copy. The image is decorative (`alt=""`): step 3 carries the same
 * fact in words for screen readers.
 */
export const SlackTokenHowTo = () => (
  <Dialog>
    <DialogTrigger asChild>
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline underline-offset-2"
      >
        How do I get this?
      </button>
    </DialogTrigger>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Get an App Configuration token</DialogTitle>
        <DialogDescription>
          Slack issues this from its own apps page. It takes about a minute.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <ol className="list-decimal space-y-2 pl-4 text-sm">
          <li>{slackTokenOpenStep}</li>
          <li>
            Click <span className="font-medium">Generate Token</span> and pick
            your workspace.
          </li>
          <li>
            Copy the{" "}
            <span className="text-foreground font-medium">Refresh Token</span>,
            not the Access Token.
          </li>
        </ol>
        <Image
          src="/slack-app-config-tokens.png"
          alt=""
          width={1640}
          height={430}
          // The dialog's inner width (sm:max-w-xl minus its padding), so the
          // browser picks a rendition near that instead of the full 1640px.
          sizes="(min-width: 640px) 528px, 100vw"
          className="w-full rounded-md border"
        />
        <p className="text-muted-foreground text-sm">
          Paste it right away. Each refresh token works once, and OneCLI rotates
          it from then on.
        </p>
      </div>
    </DialogContent>
  </Dialog>
);
