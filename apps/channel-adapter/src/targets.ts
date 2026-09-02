import type { AdapterLink } from "@onecli/agent-protocol";

/**
 * Where a link's provider-side posts go — the one address rule shared by the
 * completion pass (answers/mirrors) and the approvals manager (cards).
 */

export interface ReplyTarget {
  channel: string;
  threadTs: string | null;
}

/** Where one channel post goes — the credential plus the thread address.
 * The base shape both channel seams (`ApprovalCardUi`, `MirrorPosts`)
 * extend, so a new target field lands in one place. */
export interface ChannelPostTarget {
  credential: string;
  channel: string;
  threadTs?: string;
  iconUrl?: string;
}

/** `direct` links address the IM channel; `group` links pack
 * `<channel>:<threadRootTs>` into the external thread id. */
export const replyTargetForLink = (
  link: Pick<AdapterLink, "kind" | "externalThreadId">,
): ReplyTarget => {
  if (link.kind === "direct") {
    return { channel: link.externalThreadId, threadTs: null };
  }
  const separator = link.externalThreadId.indexOf(":");
  if (separator === -1) {
    return { channel: link.externalThreadId, threadTs: null };
  }
  return {
    channel: link.externalThreadId.slice(0, separator),
    threadTs: link.externalThreadId.slice(separator + 1),
  };
};

/**
 * Where ONE TURN's answer belongs — the link's address, narrowed to the
 * thread the turn actually arrived in when the control plane recorded one.
 *
 * A link resolves a single address per conversation, which is exactly right
 * for a channel thread (the thread IS the conversation) but not for a DM:
 * one direct conversation carries every thread the person opens inside it,
 * so answering at the link alone posts a threaded question's answer at the
 * bottom of the DM, where nobody is looking.
 *
 * The CHANNEL always comes from the link — never from the turn. The turn
 * only ever narrows WHERE IN that conversation the answer lands, so a
 * malformed or stale value can misplace a reply inside the conversation it
 * already belongs to, and can never redirect it into another one.
 */
export const replyTargetForTurn = (
  link: Pick<AdapterLink, "kind" | "externalThreadId">,
  turn: { sourceThreadId?: string | null },
): ReplyTarget => {
  const target = replyTargetForLink(link);
  // Absent (an older control plane, or a turn that arrived at the link's own
  // address) keeps the link's target verbatim — the pre-existing behavior.
  return turn.sourceThreadId
    ? { ...target, threadTs: turn.sourceThreadId }
    : target;
};
