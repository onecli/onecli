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

/**
 * A provider's decoding of its own thread address (`externalThreadId` is
 * provider-opaque to everything in this directory): which space to post in
 * and, for a thread, the thread key. Supplied by the provider module
 * (`ChannelAdapterProvider.threadAddress`), never assumed here.
 *
 * The ADDRESS alone decides — not the link's `kind`. Slack packs
 * `<channel>:<threadRootTs>` for every thread, in a channel or inside a DM
 * (the codec lives in @onecli/channels/slack so both runtimes read the one
 * format); only a DM's top level is a bare channel id. `kind` says which
 * SURFACE the link is, which is a routing fact, not an address.
 */
export type ThreadAddressDecoder = (externalThreadId: string) => ReplyTarget;

export const replyTargetForLink = (
  decode: ThreadAddressDecoder,
  link: Pick<AdapterLink, "externalThreadId">,
): ReplyTarget => decode(link.externalThreadId);

/**
 * Where ONE TURN's answer belongs — the link's address, narrowed to the
 * thread the turn actually arrived in when the control plane recorded one.
 *
 * A link resolves a single address per conversation, which is right for a
 * thread of its own (the thread IS the conversation) but not for a DM's top
 * level: that one row carries the turns typed at the bottom of the DM, and
 * a point-of-contact room link likewise spans the threads under it, so
 * answering at the link alone posts a threaded question's answer where
 * nobody is looking.
 *
 * The CHANNEL always comes from the link — never from the turn. The turn
 * only ever narrows WHERE IN that conversation the answer lands, so a
 * malformed or stale value can misplace a reply inside the conversation it
 * already belongs to, and can never redirect it into another one.
 */
export const replyTargetForTurn = (
  decode: ThreadAddressDecoder,
  link: Pick<AdapterLink, "externalThreadId">,
  turn: { sourceThreadId?: string | null },
): ReplyTarget => {
  const target = replyTargetForLink(decode, link);
  // Absent (an older control plane, or a turn that arrived at the link's own
  // address) keeps the link's target verbatim — the pre-existing behavior.
  return turn.sourceThreadId
    ? { ...target, threadTs: turn.sourceThreadId }
    : target;
};
