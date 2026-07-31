import { formatRelative } from "./format";

/**
 * Lookback for an agent's `lastSeenAt` on the agents list: the newest
 * request_logs row inside this window. Bounded so the per-project group-by
 * rides the (project_id, created_at) index instead of walking a busy
 * project's whole log history — and mirrored by `agentLastSeen` below, which
 * needs the same number to tell "never used" from "quiet longer than the
 * window". Client-safe (no db/next imports) for exactly that reason.
 */
export const LAST_SEEN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const FRESH_WINDOW_MS = 60 * 60 * 1000;

export interface AgentLastSeen {
  label: string;
  /** Exact timestamp for a hover title; null when there is nothing to show. */
  exactAt: Date | null;
  /** Seen within the last hour — the card renders its activity dot. */
  fresh: boolean;
}

/**
 * The card-facing reading of `lastSeenAt`. Agents have no presence — no
 * heartbeat, no connection — so "seen" can only ever mean "made a gateway
 * request". Null is ambiguous by construction (the window bounds the query):
 * an agent *created inside* the window provably never made a request, while
 * an older agent may just have been quiet longer than the window — the two
 * get honest, distinct labels.
 */
export const agentLastSeen = (
  lastSeenAt: Date | string | null,
  createdAt: Date | string,
  now = Date.now(),
): AgentLastSeen => {
  if (lastSeenAt !== null) {
    const seen = new Date(lastSeenAt);
    const relative = formatRelative(seen.toISOString(), now);
    return {
      // formatRelative capitalizes its "Just now" arm for standalone use;
      // mid-sentence it reads broken.
      label: `Last seen ${relative === "Just now" ? "just now" : relative}`,
      exactAt: seen,
      fresh: now - seen.getTime() < FRESH_WINDOW_MS,
    };
  }
  const neverUsed = now - new Date(createdAt).getTime() < LAST_SEEN_WINDOW_MS;
  return {
    label: neverUsed ? "Never used" : "No recent activity",
    exactAt: null,
    fresh: false,
  };
};
