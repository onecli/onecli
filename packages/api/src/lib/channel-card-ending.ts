/**
 * How a channel approval card says it ended once its request left the
 * gateway's pending list without a click on that card: the same words the
 * web card uses, chosen from the API's record, never guessed. Every channel
 * (Slack today, Teams next) settles through these, so a person sees one
 * story whichever surface they read.
 *
 * Pure and dependency-free: the channel adapter imports it.
 */

/** How a settled request on a channel card ended, as its card says it. */
export type ChannelCardEnding =
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "replaced"
  /** Settled by a click on a channel card (the card ledger says so) and the
   * record has not named how yet. */
  | "decided"
  /** Left the list and nothing says how: the card says only what it saw. */
  | "unknown";

/** Each ending as a grouped card's done list counts it ("2 cancelled"). */
export const CHANNEL_CARD_DONE_LABEL: Record<ChannelCardEnding, string> = {
  approved: "approved",
  denied: "denied",
  expired: "expired",
  cancelled: "cancelled",
  replaced: "replaced",
  decided: "decided",
  unknown: "no longer waiting",
};

/** The settled line at the deadline: the gateway auto-denies. */
export const CHANNEL_CARD_EXPIRED_TEXT = "Expired (no response) · denied";

/** The settled line of a request a person's newer message withdrew. */
export const CHANNEL_CARD_REPLACED_TEXT = "Replaced by your message · not sent";

/** How long a departed card waits for the record before saying only what
 * it saw: a cancel is written a beat after the request leaves the list. */
export const CHANNEL_CARD_RECORD_WAIT_MS = 15_000;

/** The record's outcome as a card ending. `undefined` = no usable answer
 * (no record yet, or an ending this build does not know: a newer control
 * plane may name one). */
export const channelCardEndingOf = (
  outcome: string | undefined,
): "approved" | "denied" | "cancelled" | "replaced" | undefined => {
  switch (outcome) {
    case "approved":
    case "denied":
    case "cancelled":
    case "replaced":
      return outcome;
    default:
      return undefined;
  }
};

/**
 * A single card's settled line for an ending the record named. A decision
 * is placed only where the record places it: the dashboard (`via` "web",
 * or no place: a dashboard click the gateway alone recorded). One made on a
 * channel reads as the decision alone.
 */
export const channelCardEndingText = (
  ending: "approved" | "denied" | "cancelled" | "replaced" | "unknown",
  via?: string,
): string => {
  const onDashboard = via === undefined || via === "web";
  switch (ending) {
    case "approved":
      return onDashboard ? "✅ Approved from the dashboard" : "✅ Approved";
    case "denied":
      return onDashboard ? "⛔ Denied from the dashboard" : "⛔ Denied";
    case "cancelled":
      return "Cancelled · the agent stopped waiting";
    case "replaced":
      return CHANNEL_CARD_REPLACED_TEXT;
    case "unknown":
      return "No longer waiting";
  }
};
