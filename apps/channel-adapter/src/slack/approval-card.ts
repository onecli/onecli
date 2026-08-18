import { escapeSlackText } from "@onecli/agent-protocol";
import type { ApprovalCardUi, PendingApproval } from "../approvals";
import { postBlocks, SlackApiError, updateBlocks } from "./client";

/**
 * The Slack rendering of the approvals manager's card seam: Block Kit in,
 * `chat.postMessage`/`chat.update` out. The manager itself (../approvals)
 * stays channel-general — everything Slack-shaped about an approval card
 * lives here.
 */

/** Clamp one ESCAPED dynamic field. Clamping after escaping is what makes
 * the section budget real: escaping expands (`&` → `&amp;`, ×5 worst case),
 * so a pre-escape clamp of 200 could still land 1,000 chars in the block. A
 * torn trailing entity under the ellipsis renders as its literal chars —
 * harmless in already-escaped text. */
const clampDetail = (value: string): string =>
  value.length <= 200 ? value : `${value.slice(0, 200)}…`;

/** The joined details string stays under Slack's 3,000-char section cap with
 * margin — one oversized card would otherwise kill the whole post with
 * invalid_blocks and silence the approval. */
const DETAILS_BUDGET = 2_800;

/** Slack header blocks cap plain_text at 150 chars — clamp with room for the
 *  "Approval needed · " prefix. */
const clampHeader = (value: string): string =>
  value.length <= 120 ? value : `${value.slice(0, 120)}…`;

/** Line terminators that would escape the `>` blockquote continuation —
 * normalized to `\n` first (same class slack/mrkdwn.ts normalizes). */
const normalizeLines = (value: string): string =>
  value.replace(/\r\n?|[\u{2028}\u{2029}]/gu, "\n");

/** The card. Template text is OURS; every dynamic field is escaped. */
export const approvalCardBlocks = (approval: PendingApproval): unknown[] => {
  // Header block is plain_text (Slack cap: 150 chars) — no mrkdwn escaping,
  // no pings possible; just clamp so an unbounded action can't kill the post.
  const headerAction = approval.summary?.action
    ? clampHeader(approval.summary.action)
    : undefined;
  const fallbackTitle = `${escapeSlackText(approval.method ?? "?")} ${escapeSlackText(approval.host ?? "")}${clampDetail(escapeSlackText(approval.path ?? ""))}`;
  const detailLines = (approval.summary?.details ?? [])
    .slice(0, 8)
    .map(
      (d) =>
        `>*${clampDetail(escapeSlackText(normalizeLines(d.label)))}:* ${clampDetail(escapeSlackText(normalizeLines(d.value))).replace(/\n/g, "\n>")}`,
    );
  // Hard section budget: keep whole lines while they fit, and say how many
  // were dropped rather than truncating silently.
  const kept: string[] = [];
  let used = 0;
  for (const line of detailLines) {
    if (used + line.length + 1 > DETAILS_BUDGET) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = detailLines.length - kept.length;
  if (dropped > 0) kept.push(`>_+${dropped} more_`);
  const details = kept.join("\n");
  const body = headerAction
    ? details
    : `*${fallbackTitle}*${details ? `\n${details}` : ""}`;
  const expires = approval.expiresAt
    ? `Expires <!date^${Math.floor(new Date(approval.expiresAt).getTime() / 1000)}^{time_secs}|soon>. Undecided means denied.`
    : "Undecided means denied.";
  const requester = [
    approval.agent?.name
      ? `:robot_face: ${escapeSlackText(approval.agent.name)}`
      : undefined,
    approval.host ? `\`${escapeSlackText(approval.host)}\`` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🛡️ Approval needed${headerAction ? ` · ${headerAction}` : ""}`,
        emoji: true,
      },
    },
    ...(body
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: body },
          },
        ]
      : []),
    {
      type: "context",
      elements: [
        ...(requester ? [{ type: "mrkdwn" as const, text: requester }] : []),
        { type: "mrkdwn", text: expires },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          action_id: "channel_approve",
          value: approval.id,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          action_id: "channel_deny",
          value: approval.id,
        },
      ],
    },
  ];
};

export const slackApprovalCardUi: ApprovalCardUi = {
  async post(input) {
    const posted = await postBlocks(input.credential, {
      channel: input.channel,
      text: "Approval needed",
      blocks: approvalCardBlocks(input.approval),
      ...(input.threadTs && { threadTs: input.threadTs }),
      ...(input.iconUrl && { iconUrl: input.iconUrl }),
    });
    return { channel: posted.channel, ts: posted.ts };
  },
  async settle(input) {
    // A settled card still says WHAT was asked — a thread of bare outcomes
    // ("Decided", "Decided", "Decided") is unreadable in channel history.
    // The title is one line here: line breaks collapse to spaces.
    const text = input.title
      ? `${escapeSlackText(clampHeader(normalizeLines(input.title).replace(/\n+/g, " ")))} · ${input.text}`
      : input.text;
    try {
      await updateBlocks(input.credential, {
        channel: input.channel,
        ts: input.ts,
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      });
    } catch (err) {
      // A permanently-gone card counts as settled (the seam contract): it
      // cannot mislead anyone, and retrying chat.update against it every
      // sweep forever would wedge the ledger row pending across restarts.
      const gone =
        err instanceof SlackApiError &&
        (err.code === "message_not_found" ||
          err.code === "channel_not_found" ||
          err.code === "is_archived");
      if (!gone) throw err;
    }
  },
};
