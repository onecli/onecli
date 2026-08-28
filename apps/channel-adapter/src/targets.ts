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
