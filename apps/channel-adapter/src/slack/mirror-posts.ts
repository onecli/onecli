import { escapeSlackText } from "@onecli/agent-protocol";
import { providerDisplayName, providerIconUrl } from "../mirror";
import type { MirrorPosts } from "../mirror";
import type { ChannelPostTarget } from "../targets";
import { postBlocks, postMessage } from "./client";
import { markdownToMrkdwn } from "./mrkdwn";

/** Slack's per-section text cap is 3,000 — cut with headroom, at a newline
 * where one exists in the back half of the window. */
const SECTION_TEXT_LIMIT = 2900;

/** Slack's per-message block ceiling, with headroom — a post past 50 blocks
 * is rejected whole (`invalid_blocks`). */
const BLOCK_BUDGET = 48;

const sectionChunks = (text: string): string[] => {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > SECTION_TEXT_LIMIT) {
    const window = rest.slice(0, SECTION_TEXT_LIMIT);
    const newline = window.lastIndexOf("\n");
    let cut = newline > SECTION_TEXT_LIMIT / 2 ? newline : SECTION_TEXT_LIMIT;
    // Never cut inside a `<url|label>` token — the tail half would render as
    // literal angle-bracket soup. A still-open `<` before the cut moves the
    // cut to just before it; a degenerate token longer than half the window
    // keeps the hard cut. (Newline cuts are safe by construction — the
    // converter's URLs never contain whitespace — but the check is cheap and
    // uniform.)
    const open = rest.lastIndexOf("<", cut - 1);
    if (open > SECTION_TEXT_LIMIT / 2) {
      const close = rest.indexOf(">", open);
      if (close === -1 || close >= cut) cut = open;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
};

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

/** The plain answer post — model markdown converted to mrkdwn, untruncated
 * (an oversized converted answer failing here is the recorded
 * markdownToMrkdwn output-clamp follow-up). `connectCards()`'s over-budget
 * degrade deliberately does NOT ride this: its inputs are past the 40k text
 * cap by construction, so it truncates — see the branch itself. */
const postPlainAnswer = async (
  input: ChannelPostTarget & { markdown: string },
): Promise<void> => {
  await postMessage(input.credential, {
    channel: input.channel,
    text: markdownToMrkdwn(input.markdown),
    ...targetForm(input),
  });
};

/**
 * The shared shape of a key-problem card. Structured, not prose: Slack has
 * no width control, so a long sentence renders as one hard-to-scan line. A
 * short headline, a muted context line, and the button AS the call to
 * action reads in three clean rows. The canonical sentence stays as the
 * notification fallback text; only the three strings differ per failure.
 */
const modelKeyCard = async (
  input: ChannelPostTarget & { modelsUrl: string; answer: string },
  copy: { headline: string; context: string; button: string },
): Promise<void> => {
  await postBlocks(input.credential, {
    channel: input.channel,
    text: markdownToMrkdwn(input.answer),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: copy.headline },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: copy.context }],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: copy.button },
            url: input.modelsUrl,
            action_id: "open_models_page",
          },
        ],
      },
    ],
    ...targetForm(input),
  });
};

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
    await postPlainAnswer(input);
  },
  async connectCards(input) {
    const text = markdownToMrkdwn(input.markdown);
    // Slack caps a section's text at 3,000 chars and rejects the WHOLE post
    // past it (invalid_blocks) — after the cursor already advanced, that
    // would silently drop the answer. Hence chunked sections. The chunk
    // COUNT is unbounded by the mirror's input-side 40k fence (escaping
    // inside the converter expands `&`/`<`/`>` up to 5×), so a section flood
    // plus the card rows can still crest Slack's 50-block ceiling — that
    // shape degrades to a plain answer, because a delivered answer beats a
    // prettier lost one. Any input that trips the budget converted past the
    // 40k text cap too (28+ full chunks ≥ 40.6k), so the plain fallback must
    // truncate or chat.postMessage rejects it whole (msg_too_long) — the
    // exact loss the degrade exists to prevent.
    const sections = sectionChunks(text);
    if (sections.length + input.links.length * 2 > BLOCK_BUDGET) {
      const plain = markdownToMrkdwn(input.fullMarkdown);
      // Cut backing off a still-open `<url|label>` token (the sectionChunks
      // rule) and a split surrogate pair.
      let cut = 39_000;
      const open = plain.lastIndexOf("<", cut - 1);
      if (open > 0 && open >= cut - 2_100) {
        const closeAt = plain.indexOf(">", open);
        if (closeAt === -1 || closeAt >= cut) cut = open;
      }
      const truncated =
        plain.length > 39_000
          ? `${plain.slice(0, cut).replace(/[\uD800-\uDBFF]$/, "")}\n… (truncated)`
          : plain;
      await postMessage(input.credential, {
        channel: input.channel,
        text: truncated,
        ...targetForm(input),
      });
      return;
    }
    await postBlocks(input.credential, {
      channel: input.channel,
      // The notification fallback, not the content (the sections carry
      // that) — and past 40k a text field rejects the whole post
      // (msg_too_long), so it stays one section's worth.
      text:
        sections[0] ??
        input.links
          .map((link) => providerDisplayName(link.provider))
          .join(", "),
      blocks: [
        ...sections.map((chunk) => ({
          type: "section",
          text: { type: "mrkdwn", text: chunk },
        })),
        // Compact: one context row (icon + name + state) and one actions
        // row per app. No divider and no section header — Slack's fixed
        // inter-block spacing makes each extra block a visible gap.
        ...input.links.flatMap((link) => [
          {
            type: "context",
            elements: [
              {
                type: "image",
                image_url: providerIconUrl(link.provider),
                alt_text: providerDisplayName(link.provider),
              },
              {
                // The state line is INTENT-framed, never asserted: `kind`
                // derives from the URL shape in a MODEL-authored answer, and
                // the adapter (unlike the web card, which corroborates
                // against the real connection pool) has no data plane to
                // verify a "Connected" claim — official chrome must not
                // vouch for it. "Not connected yet" stays: claiming absence
                // is the low-stakes direction, and the dialog shows the
                // truth either way.
                type: "mrkdwn",
                text: `*${escapeSlackText(providerDisplayName(link.provider))}* · ${
                  link.kind === "attach"
                    ? "Attach an account to this agent"
                    : "Not connected yet"
                }`,
              },
            ],
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: link.kind === "attach" ? "Attach" : "Connect",
                },
                url: link.url,
                action_id: `open_connect_${link.provider}`,
              },
            ],
          },
        ]),
      ],
      ...targetForm(input),
    });
  },
  async noModelKey(input) {
    await modelKeyCard(input, {
      headline: "*This agent has no model key yet*",
      context:
        "Nothing to answer with until a key is connected. Connect one, then send your message again.",
      button: "Connect a model key",
    });
  },
  async providerError(input) {
    // Same card shape as noModelKey — this failure differs only in WHY the
    // key is the fix: one exists but the provider refused it.
    await modelKeyCard(input, {
      headline: "*The model provider rejected the request*",
      context:
        "Usually a usage limit or an expired key. Check the key or connect a different one, then send your message again.",
      button: "Check the model key",
    });
  },
  async trialCreditExhausted(input) {
    // Same card shape again; this one's fix is ADDING a key — the agent was
    // running on OneCLI's free credit and there is no user key to check.
    await modelKeyCard(input, {
      headline: "*The free trial credit is used up*",
      context:
        "This agent was running on OneCLI's free credit, which ran out. Add your own model key, then send your message again.",
      button: "Add a model key",
    });
  },
  async failureNotice(input) {
    // Platform chrome, not the agent's voice: one plain italic line (the
    // automation caption's treatment), with a warning icon for failures and
    // nothing for the quiet "Stopped." A single postMessage keeps the
    // rejection modes minimal — this is the mirror's last word for the turn,
    // posted after the cursor already advanced.
    const line = `_${escapeSlackText(input.message)}_`;
    await postMessage(input.credential, {
      channel: input.channel,
      text: input.warn ? `:warning: ${line}` : line,
      ...targetForm(input),
    });
  },
};
