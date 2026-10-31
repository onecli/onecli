import {
  escapeSlackText,
  postEphemeral,
  postMessage,
} from "@onecli/channels/slack";
import type { ChannelProvider } from "../../types";
import { parseSlackPresenceCredentials } from "./types";
import { logger } from "../../../../lib/logger";

const log = logger.child({ component: "slack-outcome-reply" });

/**
 * Slack's half of `ChannelProvider.replyToOutcome`: the replies a dispatched
 * event owes on the events transport. The socket adapter answers the same
 * outcomes on its own side (`respondToOutcome`), so the two transports post
 * the same things.
 */
export const replyToSlackOutcome: NonNullable<
  ChannelProvider["replyToOutcome"]
> = async ({ credentialsJson, iconUrl, result }) => {
  const { botToken } = parseSlackPresenceCredentials(credentialsJson);
  if (!botToken) return;
  const icon = iconUrl ? { iconUrl } : {};
  const post = (send: () => Promise<unknown>) =>
    send().then(
      () => undefined,
      (err: unknown) => log.warn({ err }, "slack outcome reply failed"),
    );

  if (result.kind === "message" && result.outcome.kind === "refused") {
    // Covers the follow-up cap too: a refusal must stay VISIBLE, or the
    // silent-drop bug this feature killed is reborn at message #11.
    const message = result.outcome.message;
    await post(() =>
      postMessage(botToken, {
        channel: result.call.replyChannel,
        threadTs: result.call.replyThreadTs ?? undefined,
        text: escapeSlackText(message),
        ...icon,
      }),
    );
    return;
  }
  if (result.kind === "invite" && result.outcome.kind === "refuse") {
    // Refuse-and-stay-muted: no leave call (it would need channel-manage
    // scopes; see the door). The refusal itself is the signal.
    const message = result.outcome.message;
    await post(() =>
      postMessage(botToken, {
        channel: result.call.channel,
        text: escapeSlackText(message),
        ...icon,
      }),
    );
    return;
  }
  if (result.kind === "stop" && result.outcome.kind === "refused") {
    // A refused Stop is the clicker's business alone: a private note in the
    // thread they clicked in. An authorized stop's close posts "Stopped."
    const { channel, threadTs, externalUserId } = result.call;
    const message = result.outcome.message;
    await post(() =>
      postEphemeral(botToken, {
        channel,
        threadTs,
        user: externalUserId,
        text: escapeSlackText(message),
      }),
    );
  }
};
