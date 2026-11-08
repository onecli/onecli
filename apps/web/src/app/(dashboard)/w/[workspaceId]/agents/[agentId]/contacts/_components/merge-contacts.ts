import type {
  AgentChannelPresence,
  ChannelPersonReach,
  ChannelProvider,
  ChannelSpaceReach,
} from "@/lib/api";

/**
 * One person or channel the agent deals with: its reach row (its ONE
 * setting), keyed on the provider id. Several live presences can carry the
 * same person or channel; the first one shown wins, so each appears once.
 */
export interface MergedEntry<Reach> {
  /** The provider id (the Slack user / channel id). */
  key: string;
  /** The reach row: the one setting, and the presence's provider. */
  reach: { provider: ChannelProvider; value: Reach };
}

const mergeByRef = <Reach extends { externalRef: string }>(
  reaches: { provider: ChannelProvider; value: Reach }[],
): MergedEntry<Reach>[] => {
  const byRef = new Map<string, MergedEntry<Reach>>();
  for (const reach of reaches) {
    const ref = reach.value.externalRef;
    if (!byRef.has(ref)) byRef.set(ref, { key: ref, reach });
  }
  return [...byRef.values()];
};

/** People, the workspace owners always first (their row is fixed, so it
 *  leads whichever presence it came from). */
export const mergePeople = (
  presences: AgentChannelPresence[],
): MergedEntry<ChannelPersonReach>[] => {
  const merged = mergeByRef(
    presences.flatMap((p) =>
      (p.people ?? []).map((value) => ({ provider: p.provider, value })),
    ),
  );
  return [
    ...merged.filter((e) => e.reach.value.isOwner),
    ...merged.filter((e) => !e.reach.value.isOwner),
  ];
};

export const mergeChannels = (
  presences: AgentChannelPresence[],
): MergedEntry<ChannelSpaceReach>[] =>
  mergeByRef(
    presences.flatMap((p) =>
      (p.spaces ?? []).map((value) => ({ provider: p.provider, value })),
    ),
  );

/** The row's name: the reach label, or the provider id when there is none. */
export const nameOf = (entry: MergedEntry<{ label: string | null }>): string =>
  entry.reach.value.label ?? entry.key;
