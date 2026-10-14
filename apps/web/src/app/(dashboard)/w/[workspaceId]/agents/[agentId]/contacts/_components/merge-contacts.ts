import type {
  AgentChannelPresence,
  AgentContact,
  ChannelPersonReach,
  ChannelProvider,
  ChannelSpaceReach,
} from "@/lib/api";

/**
 * One person or channel the agent deals with, BOTH directions on one row.
 *
 * The server keeps the two directions in separate records: a reach row
 * (they wrote to the agent: does it answer?) on the channel presence, and
 * a contact row (the agent wrote to them on its own: may it?) in the
 * outbound address book. Shown separately, the same human appeared twice
 * ("@akim" and "Alex Kim") with two unlabeled badges. Both records key on the
 * same provider id (the Slack user / channel id), so they merge here.
 */
export interface MergedEntry<Reach> {
  /** The provider id both halves share. */
  key: string;
  /** The inbound half: the reach row, when one is on show. */
  reach: { provider: ChannelProvider; value: Reach } | null;
  /** The outbound half: the contact row, once the agent has one for them. */
  contact: AgentContact | null;
}

const mergeByRef = <Reach extends { externalRef: string }>(
  reaches: { provider: ChannelProvider; value: Reach }[],
  contacts: AgentContact[],
): MergedEntry<Reach>[] => {
  const byRef = new Map<string, MergedEntry<Reach>>();
  for (const reach of reaches) {
    const ref = reach.value.externalRef;
    if (!byRef.has(ref)) byRef.set(ref, { key: ref, reach, contact: null });
  }
  for (const contact of contacts) {
    const existing = byRef.get(contact.externalRef);
    if (existing) existing.contact = contact;
    else
      byRef.set(contact.externalRef, {
        key: contact.externalRef,
        reach: null,
        contact,
      });
  }
  return [...byRef.values()];
};

export const mergePeople = (
  presences: AgentChannelPresence[],
  contacts: AgentContact[],
): MergedEntry<ChannelPersonReach>[] =>
  mergeByRef(
    presences.flatMap((p) =>
      (p.people ?? []).map((value) => ({ provider: p.provider, value })),
    ),
    contacts.filter((c) => c.kind === "person"),
  );

export const mergeChannels = (
  presences: AgentChannelPresence[],
  contacts: AgentContact[],
): MergedEntry<ChannelSpaceReach>[] =>
  mergeByRef(
    presences.flatMap((p) =>
      (p.spaces ?? []).map((value) => ({ provider: p.provider, value })),
    ),
    contacts.filter((c) => c.kind === "channel"),
  );

/** "@akim" → "akim": the handle without the provider's sigil. */
const bare = (label: string): string => label.replace(/^[@#]/, "");

/**
 * The row's name and the quiet line under it. The contact's display name
 * (the provider's real name) wins as the title; the reach label (the
 * provider handle, "@akim") becomes the subtitle, unless it would only
 * repeat the title. With neither, the provider id is all there is.
 */
export const namesOf = (
  entry: MergedEntry<{ label: string | null }>,
): { title: string; subtitle: string | null } => {
  const handle = entry.reach?.value.label ?? null;
  const title = entry.contact?.displayName ?? handle ?? entry.key;
  const subtitle =
    handle && bare(handle).toLowerCase() !== bare(title).toLowerCase()
      ? handle
      : null;
  return { title, subtitle };
};
