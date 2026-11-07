import {
  clampHeader,
  escapeSlackText,
  normalizeLines,
  unpackMessageRef,
  updateBlocksMessage,
} from "@onecli/channels/slack";
import { parseSlackPresenceCredentials } from "./types";

/**
 * The control plane's rewrite of a posted GATEWAY approval card (the
 * adapter posts it; `tool_approval_cards.externalMessageRef` names it), in
 * the same one-line shape the adapter's own settle writes: the request's
 * title, then its outcome ("Create 9 Accounts · Replaced by your message").
 * Both are escaped here, and any CSV the bulk card carried is detached
 * (`fileIds: []`), so a settled card never keeps its table.
 *
 * A malformed ref or a credential without a bot token is a no-op: the card
 * is cosmetic, the decision is already delivered at the gateway.
 */
export const settleSlackGatewayApprovalCard = async (input: {
  credentialsJson: string;
  externalMessageRef: string;
  title: string | undefined;
  text: string;
}): Promise<void> => {
  const ref = unpackMessageRef(input.externalMessageRef);
  if (!ref) return;
  const creds = parseSlackPresenceCredentials(input.credentialsJson);
  if (!creds.botToken) return;
  const outcome = escapeSlackText(input.text);
  const text = input.title
    ? `${escapeSlackText(clampHeader(normalizeLines(input.title).replace(/\n+/g, " ")))} · ${outcome}`
    : outcome;
  await updateBlocksMessage(creds.botToken, {
    channel: ref.channel,
    ts: ref.ts,
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
    fileIds: [],
  });
};
