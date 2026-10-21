import type { SettledOutcome } from "@/lib/api/approvals";
import { providerLabel } from "@/lib/agents/channel-provider-ui";

/**
 * Where a decision came from, appended to its label when that was a channel:
 * "Approved" becomes "Approved in Slack". Only decisions a person made carry
 * a place (an expiry or a replacement happened here, to everyone).
 */
export const withDecidedVia = (
  label: string,
  outcome: SettledOutcome,
  via: string | undefined,
): string =>
  via && via !== "web" && (outcome === "approved" || outcome === "denied")
    ? `${label} in ${providerLabel(via)}`
    : label;
