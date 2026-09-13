/**
 * @onecli/channels — the channel-provider layer BOTH runtimes share.
 *
 * The api's control plane (attach, webhooks, services) and the
 * channel-adapter (socket mode, mirror posts, cards) are different runtimes
 * with different physics, but they speak to the same provider APIs. This
 * package is the single home for that wire layer: one client per provider,
 * one error base, one set of text-shaping helpers — so the two runtimes can
 * never drift apart on retry policy, escaping order, or block limits.
 *
 * WHAT DOES NOT BELONG HERE, so the package stays runtime-neutral:
 *   - anything importing the DB or the api's services (ingestion, reach,
 *     approvals stay in `packages/api`);
 *   - anything bound to one runtime's transport (socket-mode lives in the
 *     adapter; webhook signature verification in the api);
 *   - single-consumer code (the adapter's `mrkdwn.ts` converter moves here
 *     only when a second runtime needs it — its own header says so).
 *
 * Per-provider code lives under `src/<provider>/` and is exported as a
 * subpath (`@onecli/channels/slack`), so importing one provider never loads
 * another and adding Teams or Telegram is a directory plus an id.
 */

export {
  CHANNEL_PROVIDER_IDS,
  ChannelProviderApiError,
  isChannelProviderId,
  type ChannelProviderId,
} from "./errors";

export { readCappedBinaryBody } from "./http";
export {
  MAX_MENTION_TOKENS,
  mentionNamesOf,
  normalizeMentionName,
  plainMentionCandidatesOf,
  replaceMentionTokens,
  scanMentionTokens,
  type MentionToken,
} from "./mentions";
