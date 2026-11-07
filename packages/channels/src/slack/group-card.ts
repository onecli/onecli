/**
 * The grouped approval card's button vocabulary, shared by the card's
 * renderer (the channel adapter) and BOTH click arms (the adapter's socket
 * handler and the control plane's HTTP interactivity route), so the three
 * can never disagree on what a click means.
 *
 * A button's `value` carries ONLY opaque approval ids (Slack caps `value` at
 * 2,000 chars): the ids of exactly the rows the card showed. The control
 * plane refuses the click unless every id is one of the presence's own
 * posted cards, so a forged value decides nothing.
 */

import {
  APPROVAL_GROUP_ID_RE,
  APPROVAL_GROUP_MAX_IDS,
} from "../approval-group";

export const GROUP_APPROVE_ACTION = "channel_group_approve";
export const GROUP_DENY_ACTION = "channel_group_deny";
/** A row's overflow menu; each option's value is `approve|<id>` / `deny|<id>`.
 *  Slack wants action ids unique within a message, so rows use
 *  `rowActionId(n)`; the classifier accepts the prefix. */
export const GROUP_ROW_ACTION = "channel_group_row";
export const rowActionId = (index: number): string =>
  `${GROUP_ROW_ACTION}:${index}`;

/** Slack's button `value` cap. A full group of gateway UUIDs and their
 *  commas (50 x 36 + 49 = 1,849 chars) fits inside it. */
const SLACK_VALUE_MAX = 2_000;

/** Encode ids for a button value; `null` when they can't fit safely. */
export const packGroupIds = (ids: readonly string[]): string | null => {
  if (ids.length === 0 || ids.length > APPROVAL_GROUP_MAX_IDS) return null;
  if (!ids.every((id) => APPROVAL_GROUP_ID_RE.test(id))) return null;
  const value = ids.join(",");
  return value.length <= SLACK_VALUE_MAX ? value : null;
};

/** Decode a button value; `null` on anything malformed. */
export const unpackGroupIds = (value: string | undefined): string[] | null => {
  if (!value || value.length > SLACK_VALUE_MAX) return null;
  const ids = value.split(",");
  if (
    ids.length > APPROVAL_GROUP_MAX_IDS ||
    !ids.every((id) => APPROVAL_GROUP_ID_RE.test(id))
  ) {
    return null;
  }
  return [...new Set(ids)];
};

export interface GroupClick {
  approvalIds: string[];
  decision: "approve" | "deny";
}

/** Classify a block_actions action as a grouped-card click, or `null`. */
export const groupClickOf = (action: {
  action_id?: string;
  value?: string;
  selected_option?: { value?: string };
}): GroupClick | null => {
  if (
    action.action_id === GROUP_APPROVE_ACTION ||
    action.action_id === GROUP_DENY_ACTION
  ) {
    const approvalIds = unpackGroupIds(action.value);
    if (!approvalIds) return null;
    return {
      approvalIds,
      decision: action.action_id === GROUP_APPROVE_ACTION ? "approve" : "deny",
    };
  }
  if (
    action.action_id === GROUP_ROW_ACTION ||
    action.action_id?.startsWith(`${GROUP_ROW_ACTION}:`)
  ) {
    const parts = (action.selected_option?.value ?? "").split("|");
    if (parts.length !== 2) return null;
    const [decision, id] = parts;
    if (decision !== "approve" && decision !== "deny") return null;
    if (!id || !APPROVAL_GROUP_ID_RE.test(id)) return null;
    return { approvalIds: [id], decision };
  }
  return null;
};
