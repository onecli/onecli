import { escapeSlackText } from "@onecli/agent-protocol";
import type { MirrorPosts } from "../mirror";
import type { ChannelPostTarget } from "../targets";
import { postBlocks, postMessage } from "./client";
import { markdownToMrkdwn } from "./mrkdwn";

/**
 * The Slack rendering of the mirror's post seam. The mirror (../mirror)
 * decides WHAT to post — question, follow-up, automation report, answer —
 * and stays channel-general; this module decides HOW it reads in Slack:
 * attribution formatting, emoji, mrkdwn conversion, and Block Kit.
 */

/** The cross-surface attribution prefix — italic, so the metadata stays
 * quieter than the quoted person's own words, and by name when the control
 * plane resolved one: "_(from the web · Jonathan)_". The name is
 * user-controlled text: escaped. */
const webAttribution = (userName: string | null): string =>
  userName
    ? `_(from the web · ${escapeSlackText(userName)})_`
    : "_(from the web)_";

const targetForm = (
  input: ChannelPostTarget,
): { threadTs?: string; iconUrl?: string } => ({
  ...(input.threadTs && { threadTs: input.threadTs }),
  ...(input.iconUrl && { iconUrl: input.iconUrl }),
});

export const slackMirrorPosts: MirrorPosts = {
  async webSourced(input) {
    // The attributed mirror is a quote, not a rendering: a person who typed
    // literal asterisks said literal asterisks — escape, never convert.
    await postMessage(input.credential, {
      channel: input.channel,
      text: `${webAttribution(input.userName)} ${escapeSlackText(input.message)}`,
      ...targetForm(input),
    });
  },
  async automation(input) {
    const icon = input.source === "watch" ? ":stopwatch:" : ":calendar:";
    // The title always rides the post: two automations reporting into the
    // same thread are indistinguishable without it (model-written bodies do
    // not self-identify). It stays a quiet italic caption (quoted verbatim,
    // escape only) above the report; the body is model markdown — converted
    // (markdownToMrkdwn escapes internally).
    await postMessage(input.credential, {
      channel: input.channel,
      text: input.body
        ? `${icon} _${escapeSlackText(input.title)}_\n${markdownToMrkdwn(input.body)}`
        : `${icon} _${escapeSlackText(input.title)}_`,
      ...targetForm(input),
    });
  },
  async answer(input) {
    // The answer is model-authored markdown (or a door failure's turn.error
    // — plain text the converter passes through): convert to mrkdwn so
    // **bold**/headings/lists render instead of showing their markers
    // (escaping happens inside the converter, first).
    await postMessage(input.credential, {
      channel: input.channel,
      text: markdownToMrkdwn(input.markdown),
      ...targetForm(input),
    });
  },
  async noModelKey(input) {
    // Structured, not prose: Slack has no width control, so a long sentence
    // renders as one hard-to-scan line. A short headline, a muted context
    // line, and the button AS the call to action reads in three clean rows.
    // The canonical sentence stays as the notification fallback text.
    await postBlocks(input.credential, {
      channel: input.channel,
      text: markdownToMrkdwn(input.answer),
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*This agent has no model key yet*",
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "Nothing to answer with until a key is connected. Connect one, then send your message again.",
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Connect a model key" },
              url: input.modelsUrl,
              action_id: "open_models_page",
            },
          ],
        },
      ],
      ...targetForm(input),
    });
  },
};
