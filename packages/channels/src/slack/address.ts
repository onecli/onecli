/**
 * The Slack ADDRESS CODEC — the one place the `<channel>:<threadRootTs>`
 * packing is encoded and decoded.
 *
 * A group thread's platform address packs both halves into one opaque
 * string (`externalThreadId` on links, conversations, and reach rows); a
 * DM's address is the bare IM channel id. Before this file the codec was
 * split across three files in two runtimes — the encoder in the api's
 * interpret.ts, the full decoder in the adapter's targets.ts, and a
 * half-decoder (channel-only) in the api's reach facet — which is exactly
 * how one side changes the format and the other keeps parsing yesterday's.
 */

/** The group-thread address (the step-6 decision): the THREAD, not the
 * channel — parallel threads get parallel contexts. A top-level trigger
 * starts a thread rooted at itself. */
export const groupThreadId = (channel: string, threadRootTs: string): string =>
  `${channel}:${threadRootTs}`;

/** Where a link's posts go: `direct` links address the IM channel itself;
 * `group` links unpack the codec. A group id with no separator degrades to
 * channel-only (top-level post) rather than throwing — a malformed stored
 * address must never take down the completion pass. */
export const unpackThreadAddress = (
  kind: "direct" | "group",
  externalThreadId: string,
): { channel: string; threadTs: string | null } => {
  if (kind === "direct") return { channel: externalThreadId, threadTs: null };
  const separator = externalThreadId.indexOf(":");
  if (separator === -1) return { channel: externalThreadId, threadTs: null };
  return {
    channel: externalThreadId.slice(0, separator),
    threadTs: externalThreadId.slice(separator + 1),
  };
};

/** The SPACE behind a group-thread address (the reach ledger's channel
 * key) — the codec's channel half, tolerant of a bare channel id. */
export const spaceOfThreadAddress = (externalThreadId: string): string =>
  externalThreadId.split(":")[0] ?? "";

/**
 * A posted MESSAGE's durable ref (`<channel>:<ts>`) — same packing as the
 * thread address, different meaning: this names one message (a card the
 * settle pass rewrites), not a conversation. The control plane stores it
 * opaquely (`externalMessageRef`); only this codec reads or writes the
 * format.
 */
export const packMessageRef = (channel: string, ts: string): string =>
  `${channel}:${ts}`;

/** Null when the ref is absent or malformed — a recovered prompt with no
 * usable ref degrades to the thread address, never throws. */
export const unpackMessageRef = (
  ref: string | null | undefined,
): { channel: string; ts: string } | null => {
  if (!ref) return null;
  const separator = ref.indexOf(":");
  if (separator <= 0) return null;
  return { channel: ref.slice(0, separator), ts: ref.slice(separator + 1) };
};
