import {
  clampHeader,
  clampLabel,
  escapeSlackText,
  GROUP_APPROVE_ACTION,
  GROUP_DENY_ACTION,
  normalizeLines,
  packGroupIds,
  packMessageRef,
  postBlocksMessage,
  rowActionId,
  SlackApiError,
  unpackMessageRef,
  updateBlocksMessage,
} from "@onecli/channels/slack";
import { groupApprovals, isOddOneOut } from "@onecli/api/lib/approval-groups";
import type {
  ApprovalCardUi,
  GroupCardView,
  PendingApproval,
} from "../approvals";

/**
 * The Slack rendering of the approvals manager's card seam: Block Kit in,
 * `chat.postMessage`/`chat.update` out. The manager itself (../approvals)
 * stays channel-general — everything Slack-shaped about an approval card
 * lives here.
 */

/** The joined details string stays under Slack's 3,000-char section cap with
 * margin — one oversized card would otherwise kill the whole post with
 * invalid_blocks and silence the approval. */
const DETAILS_BUDGET = 2_800;

/** The leading items whose joined text fits `budget`, kept whole: a cut
 *  mid-item could split an escaped entity or a `<url|text>` link. */
const fitting = (
  items: readonly string[],
  separator: string,
  budget: number,
): string[] => {
  const kept: string[] = [];
  let used = 0;
  for (const item of items) {
    const cost = item.length + (kept.length > 0 ? separator.length : 0);
    if (used + cost > budget) break;
    kept.push(item);
    used += cost;
  }
  return kept;
};

/** A detail value as Slack mrkdwn, linked to its record when it has one.
 *  The URL is already https (checked channel-side in ../approvals); here
 *  only Slack's own `<url|text>` syntax is guarded: a URL carrying `|`, `<`,
 *  `>` or whitespace could break out of it, so it stays plain text. */
const detailValue = (value: string, url: string | undefined): string => {
  const text = clampLabel(escapeSlackText(normalizeLines(value)));
  return url && !/[|<>\s]/.test(url) ? `<${url}|${text}>` : text;
};

/** The card. Template text is OURS; every dynamic field is escaped. */
export const approvalCardBlocks = (approval: PendingApproval): unknown[] => {
  // Header block is plain_text (Slack cap: 150 chars) — no mrkdwn escaping,
  // no pings possible; just clamp so an unbounded action can't kill the post.
  const headerAction = approval.summary?.action
    ? clampHeader(approval.summary.action)
    : undefined;
  const fallbackTitle = `${escapeSlackText(approval.method ?? "?")} ${escapeSlackText(approval.host ?? "")}${clampLabel(escapeSlackText(approval.path ?? ""))}`;
  const detailLines = (approval.summary?.details ?? [])
    .slice(0, 8)
    .map(
      (d) =>
        `>*${clampLabel(escapeSlackText(normalizeLines(d.label)))}:* ${detailValue(d.value, d.url).replace(/\n/g, "\n>")}`,
    );
  // Hard section budget: keep whole lines while they fit, and say how many
  // were dropped rather than truncating silently.
  const kept = fitting(detailLines, "\n", DETAILS_BUDGET);
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

/** Rows that get their own ⋯ menu; the rest are listed (Slack's 50-block cap
 * and readability both say a card is not a spreadsheet). */
const MENU_ROWS = 15;
const LISTED_ROWS = 35;

const oneLine = (raw: string): string =>
  clampLabel(escapeSlackText(normalizeLines(raw).replace(/\n+/g, " ")));

/** "1 request" / "3 requests". */
const count = (n: number, noun: string): string =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;

/** `items` joined with `separator`, cut to whole items inside `budget`, with
 *  "+N more" when any were left out. */
const listWithin = (
  items: readonly string[],
  separator: string,
  budget: number,
): string => {
  const kept = fitting(items, separator, budget);
  const left = items.length - kept.length;
  return `${kept.join(separator)}${left > 0 ? `${separator}+${left} more` : ""}`;
};

/** One row's text: the action (when it isn't the card's main one) and the
 *  first two detail values, e.g. "Jane Doe · jane@acme.com". */
const rowText = (a: PendingApproval, showAction: boolean): string => {
  const details = (a.summary?.details ?? [])
    .slice(0, 2)
    .map((d) => detailValue(d.value, d.url).replace(/\n+/g, " "));
  const action = a.summary?.action ? oneLine(a.summary.action) : undefined;
  const parts = [...(showAction && action ? [`*${action}*`] : []), ...details];
  if (parts.length > 0) return parts.join(" · ");
  return `${escapeSlackText(a.method ?? "?")} ${clampLabel(escapeSlackText(a.path ?? ""))}`;
};

const OUTCOME_ICON = {
  approved: "✅",
  denied: "⛔",
  expired: "⌛",
  decided: "☑️",
} as const;

/**
 * The GROUPED card: one message for one task's approvals. Every row is its
 * own held request; Approve all / Deny all carry EXACTLY the live ids shown
 * (the control plane refuses any id not posted on this presence). A row
 * whose action differs from the card's main one is pinned first and
 * flagged, so a delete among creates can't hide. Template text is ours;
 * every dynamic field is escaped, and the agent's batch label/total are
 * shown as the agent's claim.
 */
export const groupCardBlocks = (view: GroupCardView): unknown[] => {
  const [group] = groupApprovals(view.live);
  const live = group
    ? [
        ...group.approvals.filter((a) => isOddOneOut(group, a)),
        ...group.approvals.filter((a) => !isOddOneOut(group, a)),
      ]
    : [];
  const main = group?.mainAction ?? view.settled[0]?.title ?? "Requests";
  const label =
    group?.label ?? view.settled.find((s) => s.label)?.label ?? null;
  const total = group?.total ?? null;
  const agentName = view.live[0]?.agent?.name;
  const host = view.live[0]?.host;
  const blocks: unknown[] = [];

  const doneCounts = { approved: 0, denied: 0, expired: 0, decided: 0 };
  for (const s of view.settled) doneCounts[s.outcome] += 1;
  const doneLine = (Object.keys(doneCounts) as (keyof typeof doneCounts)[])
    .filter((k) => doneCounts[k] > 0)
    .map((k) => `${OUTCOME_ICON[k]} ${doneCounts[k]} ${k}`)
    .join(" · ");

  if (live.length === 0) {
    const by = [
      ...new Set(
        view.settled.flatMap((s) => (s.by ? [escapeSlackText(s.by)] : [])),
      ),
    ];
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${oneLine(label ?? main)}* · ${count(view.settled.length, "request")}\n${doneLine}${
            by.length ? ` · by ${listWithin(by, ", ", DETAILS_BUDGET)}` : ""
          }`,
        },
      },
    ];
  }

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: clampHeader(
        `🛡️ ${count(live.length, "approval")} needed · ${main}`,
      ),
      emoji: true,
    },
  });
  if (label || total) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `The agent says: ${label ? `“${oneLine(label)}”` : "one task"}${
            total ? ` · ${count(total, "request")} in total` : ""
          }`,
        },
      ],
    });
  }
  const odd = group?.otherActions ?? [];
  if (odd.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: *Not all the same:* ${listWithin(
          odd.map((o) => `${o.count} × ${oneLine(o.action)}`),
          ", ",
          DETAILS_BUDGET,
        )}. Those are listed first.`,
      },
    });
  }

  live.slice(0, MENU_ROWS).forEach((a, i) => {
    const flagged = group ? isOddOneOut(group, a) : false;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${flagged ? ":warning: " : ""}${rowText(a, flagged)}`,
      },
      accessory: {
        type: "overflow",
        action_id: rowActionId(i),
        options: [
          {
            text: { type: "plain_text", text: "Approve this one" },
            value: `approve|${a.id}`,
          },
          {
            text: { type: "plain_text", text: "Deny this one" },
            value: `deny|${a.id}`,
          },
        ],
      },
    });
  });
  // Approve all covers ONLY rows the card shows. Rows past what fits stay
  // pending and appear on this card as the shown ones are decided.
  const shownIds = live.slice(0, MENU_ROWS).map((a) => a.id);
  const rest = live.slice(MENU_ROWS);
  let notShown = 0;
  if (rest.length > 0) {
    const listed = rest.slice(0, LISTED_ROWS);
    const lines = fitting(
      listed.map((a) => `• ${rowText(a, false)}`),
      "\n",
      DETAILS_BUDGET,
    );
    shownIds.push(...listed.slice(0, lines.length).map((a) => a.id));
    notShown = live.length - shownIds.length;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${lines.join("\n")}${notShown > 0 ? `\n_+${notShown} more waiting. They show here once these are decided, and Approve all never includes them._` : ""}`,
      },
    });
  }

  const expiresAt = group?.expiresAt;
  blocks.push({
    type: "context",
    elements: [
      ...(agentName || host
        ? [
            {
              type: "mrkdwn",
              text: [
                agentName ? `:robot_face: ${escapeSlackText(agentName)}` : null,
                host ? `\`${escapeSlackText(host)}\`` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            },
          ]
        : []),
      ...(doneLine ? [{ type: "mrkdwn", text: `Done: ${doneLine}` }] : []),
      {
        type: "mrkdwn",
        text: expiresAt
          ? `First expires <!date^${Math.floor(expiresAt / 1000)}^{time_secs}|soon>. Undecided means denied.`
          : "Undecided means denied.",
      },
    ],
  });

  const ids = packGroupIds(shownIds);
  if (ids) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: {
            type: "plain_text",
            text: `Approve ${notShown > 0 ? "these" : "all"} ${shownIds.length}`,
          },
          action_id: GROUP_APPROVE_ACTION,
          value: ids,
        },
        {
          type: "button",
          style: "danger",
          text: {
            type: "plain_text",
            text: `Deny ${notShown > 0 ? "these" : "all"} ${shownIds.length}`,
          },
          action_id: GROUP_DENY_ACTION,
          value: ids,
        },
      ],
    });
  }
  return blocks;
};

/** Slack says the card's message (or its channel) is permanently gone. */
const isGone = (err: unknown): boolean =>
  err instanceof SlackApiError &&
  (err.code === "message_not_found" ||
    err.code === "channel_not_found" ||
    err.code === "is_archived");

export const slackApprovalCardUi: ApprovalCardUi = {
  async renderGroup(input) {
    const live = input.view.live.length;
    const text = live
      ? `${count(live, "approval")} needed`
      : `${count(input.view.settled.length, "request")} decided`;
    const blocks = groupCardBlocks(input.view);
    try {
      await updateBlocksMessage(input.credential, {
        channel: input.channel,
        ts: input.ts,
        text,
        blocks,
      });
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  },
  packMessageRef: (ref) => packMessageRef(ref.channel, ref.ts),
  unpackMessageRef,
  async post(input) {
    const posted = await postBlocksMessage(input.credential, {
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
      await updateBlocksMessage(input.credential, {
        channel: input.channel,
        ts: input.ts,
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      });
    } catch (err) {
      // A permanently-gone card counts as settled (the seam contract): it
      // cannot mislead anyone, and retrying chat.update against it every
      // sweep forever would wedge the ledger row pending across restarts.
      if (!isGone(err)) throw err;
    }
  },
};
