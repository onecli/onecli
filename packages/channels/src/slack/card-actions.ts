/**
 * The buttons on the agent's narration card (the "Working on your request"
 * plan card), shared by the card's renderer (the control plane) and BOTH
 * click arms (the control plane's HTTP interactivity route and the channel
 * adapter's socket handler), so the three can never disagree on what a
 * click means.
 *
 * Two kinds of button, one trust rule. Stop acts on the card's own turn and
 * carries nothing at all. Send now acts on one waiting message, so its value
 * names that message's row id; the id is only a pointer, never an
 * authority. A click is resolved from where Slack says the card sits (the
 * conversation and the card message's own ts), and the control plane acts
 * only on what the LIVE card at that address owns on that presence. A forged
 * or replayed value can therefore reach nothing the card does not show.
 */

import type { FollowUpAction } from "../follow-up-actions";

export const TURN_STOP_ACTION = "turn_stop";
export const FOLLOW_UP_SEND_NOW_ACTION = "follow_up_send_now";

/** The Stop button as a Block Kit element (the value is required by Slack
 * and deliberately meaningless). Default style on purpose: a rarely used
 * control under a status card should be findable, not loud, so it is the
 * quiet outlined button rather than a red one. */
export const turnStopButton = {
  type: "button",
  action_id: TURN_STOP_ACTION,
  text: { type: "plain_text", text: "Stop" },
  value: "stop",
} as const;

/**
 * Send now on a waiting message's row. Shown only to the message's author
 * (`visible_to_user_ids`): the button is theirs to press, and in a shared
 * thread nobody else needs a control they cannot use. Display only: the
 * control plane checks the clicker again on every click. Default style, the
 * same quiet weight as Stop beside it.
 */
export const followUpSendNowButton = (
  followUpId: string,
  authorExternalUserId: string,
) =>
  ({
    type: "button",
    action_id: FOLLOW_UP_SEND_NOW_ACTION,
    text: { type: "plain_text", text: "Send now" },
    value: followUpId,
    visible_to_user_ids: [authorExternalUserId],
  }) as const;

/** What every card button's click shares: where the card is, and who
 * pressed. */
export interface CardClick {
  /** The conversation the card was posted in. */
  channel: string;
  /** The card message's ts: the address of the card being acted on. */
  messageTs: string;
  /** Who clicked (Slack user id), authorized control-plane-side. */
  clickerExternalUserId: string;
}

/** A click on a waiting message's row: the card's address, plus which of
 * the messages it shows was pressed. */
export interface FollowUpActionClick extends CardClick {
  action: FollowUpAction;
  followUpId: string;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Object.entries(value).find(([k]) => k === key)?.[1]
    : undefined;

/** The first action of a message-hosted `block_actions` payload, with the
 * card's address and the clicker, or `null` for anything else. */
const cardClickOf = (
  payload: unknown,
): { click: CardClick; action: unknown } | null => {
  if (field(payload, "type") !== "block_actions") return null;
  const actions = field(payload, "actions");
  const action = Array.isArray(actions) ? actions[0] : undefined;
  const container = field(payload, "container");
  if (field(container, "type") !== "message") return null;
  const channel = field(container, "channel_id");
  const messageTs = field(container, "message_ts");
  const clicker = field(field(payload, "user"), "id");
  if (!nonEmpty(channel) || !nonEmpty(messageTs) || !nonEmpty(clicker)) {
    return null;
  }
  return {
    click: { channel, messageTs, clickerExternalUserId: clicker },
    action,
  };
};

/** Classify an interactive payload as a card Stop click, or `null`. */
export const turnStopClickOf = (payload: unknown): CardClick | null => {
  const parsed = cardClickOf(payload);
  if (!parsed || field(parsed.action, "action_id") !== TURN_STOP_ACTION) {
    return null;
  }
  return parsed.click;
};

/** Classify an interactive payload as a click on a waiting message's row,
 * or `null`. */
export const followUpActionClickOf = (
  payload: unknown,
): FollowUpActionClick | null => {
  const parsed = cardClickOf(payload);
  if (
    !parsed ||
    field(parsed.action, "action_id") !== FOLLOW_UP_SEND_NOW_ACTION
  ) {
    return null;
  }
  const followUpId = field(parsed.action, "value");
  if (!nonEmpty(followUpId)) return null;
  return { ...parsed.click, action: "send_now", followUpId };
};
