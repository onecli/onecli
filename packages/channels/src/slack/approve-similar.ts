/**
 * The single-request approval card's decision buttons and settled text,
 * including "Approve similar". Shared by the card's renderer (the channel
 * adapter) and BOTH click arms (the adapter's socket handler and the control
 * plane's HTTP interactivity route), so the three never disagree on what a
 * click means or what the settled card says.
 *
 * Every button's value is ONLY the opaque approval id. What "similar" covers
 * is decided by the gateway from the held request it built; a click can ask
 * for it, never widen it.
 */

import { z } from "zod";
import { clampLabel, escapeSlackText } from "./text";

export const APPROVE_ACTION = "channel_approve";
export const APPROVE_SIMILAR_ACTION = "channel_approve_similar";
export const DENY_ACTION = "channel_deny";

/** The gateway's "Approve similar" offer on a held request. */
interface SimilarOffer {
  /** What it covers, e.g. "Attio updates to companies". */
  label: string;
  windowMinutes: number;
  maxRequests: number;
}

/** The window an "Approve similar" decision opened. */
interface OpenedWindow {
  label: string;
  /** When it closes (RFC 3339, from the gateway). */
  until: string;
}

interface ApprovalClick {
  approvalId: string;
  decision: "approve" | "deny";
  scope?: "similar";
  clickerExternalUserId: string;
}

/** The fields of a single-request card's click this module reads: the
 * button, its value (the opaque approval id, never more) and the clicker.
 * Slack sends the clicked element as the first (only) action. */
const clickPayload = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string().min(1).max(200) }),
  actions: z
    .tuple([
      z.object({
        action_id: z.enum([
          APPROVE_ACTION,
          APPROVE_SIMILAR_ACTION,
          DENY_ACTION,
        ]),
        value: z.string().min(1).max(500),
      }),
    ])
    .rest(z.unknown()),
});

/** A single-request card's click, out of a raw interactivity payload, or
 * `null` when it is not one of the card's three buttons. */
export const approvalClickOf = (payload: unknown): ApprovalClick | null => {
  const parsed = clickPayload.safeParse(payload);
  if (!parsed.success) return null;
  const [{ action_id: actionId, value: approvalId }] = parsed.data.actions;
  const clickerExternalUserId = parsed.data.user.id;
  if (actionId === APPROVE_SIMILAR_ACTION) {
    return {
      approvalId,
      decision: "approve",
      scope: "similar",
      clickerExternalUserId,
    };
  }
  return {
    approvalId,
    decision: actionId === DENY_ACTION ? "deny" : "approve",
    clickerExternalUserId,
  };
};

/** Approve, Approve similar (when the gateway offered it), Deny. A card may
 * name its Approve after what it does ("Approve update"). */
export const approvalButtons = (
  approvalId: string,
  similar: SimilarOffer | null | undefined,
  approveLabel = "Approve",
): unknown[] => [
  {
    type: "button",
    style: "primary",
    text: { type: "plain_text", text: approveLabel },
    action_id: APPROVE_ACTION,
    value: approvalId,
  },
  ...(similar
    ? [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: `Approve similar · ${similar.windowMinutes} min`,
          },
          action_id: APPROVE_SIMILAR_ACTION,
          value: approvalId,
        },
      ]
    : []),
  {
    type: "button",
    style: "danger",
    text: { type: "plain_text", text: "Deny" },
    action_id: DENY_ACTION,
    value: approvalId,
  },
];

/** What "similar" covers, as a context block under the buttons (Slack has no
 * tooltips), or nothing when the gateway did not offer it. */
export const similarNoteBlocks = (
  similar: SimilarOffer | null | undefined,
  agentName: string | undefined,
): unknown[] => {
  if (!similar) return [];
  const who = agentName ? escapeSlackText(clampLabel(agentName)) : "this agent";
  const what = escapeSlackText(clampLabel(similar.label));
  return [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Approve similar also allows up to ${similar.maxRequests} more ${what} from ${who}._`,
        },
      ],
    },
  ];
};

/** The settled card's text after a decision. `name` and the window's label
 * are untrusted and escaped here; the window's end renders in the reader's
 * own time zone (Slack's date token), with the UTC time as the fallback.
 * The token is built from the parsed time alone, never from the raw string,
 * so nothing in it can close the token early. */
export const decidedText = (
  decision: "approve" | "deny",
  name: string,
  opened?: OpenedWindow,
): string => {
  const by = escapeSlackText(name);
  if (decision === "deny") return `⛔ Denied by ${by}`;
  if (!opened) return `✅ Approved by ${by}`;
  const ms = Date.parse(opened.until);
  const label = escapeSlackText(opened.label);
  const until = Number.isFinite(ms)
    ? ` until <!date^${Math.floor(ms / 1000)}^{time}|${new Date(ms).toISOString().slice(11, 16)} UTC>`
    : "";
  return `✅ Approved by ${by} · ${label} allowed${until}`;
};
