/**
 * Grouping held approvals into one card per task, shared by the web (chat
 * card, bell) and the Slack adapter, so every surface groups the same way.
 * CLIENT-SAFE: pure data, no Node builtins, no I/O.
 *
 * A group is a DISPLAY choice only. Every approval in it is still its own
 * held request, decided on its own; "approve all" is N individual decisions
 * over the exact ids the reviewer saw.
 *
 * Key, always within one agent and one app (the batch tag is the agent's
 * claim, so it can never pull another agent's or app's request into a card):
 *  - the agent tagged the task (`batch.id`) → agent + app + batch id;
 *  - otherwise → agent + app + action ("Create Contact"), the fallback that
 *    still groups a burst from an agent that does not tag.
 *
 * "Action" is the verb WITHOUT the record: a title that names its record
 * ("Delete Contact Olivia Martinez") carries `subject.verb` ("Delete
 * Contact"), and that is what groups, so ten deletes are one card with ten
 * rows instead of ten cards. Each row still names (and links) its own record.
 */

/** The fields grouping reads: a structural subset of the pending row, so
 *  the web type and the adapter's zod type both fit without a cast. */
export interface GroupableApproval {
  id: string;
  createdAt?: string;
  expiresAt?: string;
  method?: string;
  host?: string;
  app?: string;
  agent?: { id?: string; name?: string } | null;
  summary?: {
    action?: string;
    /** The title split around its record; `verb` is the action without it. */
    subject?: { verb?: string } | null;
  } | null;
  batch?: { id: string; label?: string; total?: number } | null;
}

export interface ApprovalGroup<A extends GroupableApproval> {
  /** Stable across polls while the task is live. */
  key: string;
  /** Oldest first: the order the requests arrived. */
  approvals: A[];
  /** The agent's own label for the task, when it gave one. */
  label: string | null;
  /** How many requests the agent said the task sends, when it said so. */
  total: number | null;
  /** The most common action, and every other action with its count:
   *  anything outside the main action is called out on the card. */
  mainAction: string;
  otherActions: { action: string; count: number }[];
  /** The earliest deadline among the group's requests (ms epoch). */
  expiresAt: number | null;
}

/** The verb a request performs, minus the record its title names. */
const actionOf = (a: GroupableApproval): string =>
  a.summary?.subject?.verb?.trim() ||
  a.summary?.action?.trim() ||
  `${a.method ?? "?"} request`;

const at = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

export const approvalGroupKey = (a: GroupableApproval): string => {
  const scope = `${a.agent?.id ?? "?"}:${a.app ?? a.host ?? "?"}`;
  return a.batch?.id
    ? `batch:${scope}:${a.batch.id}`
    : `action:${scope}:${actionOf(a)}`;
};

/**
 * Group approvals, preserving arrival order: groups sort by their first
 * request, members by creation. Singletons are groups of one; callers
 * render those with the single-approval card.
 */
export const groupApprovals = <A extends GroupableApproval>(
  approvals: readonly A[],
): ApprovalGroup<A>[] => {
  const byKey = new Map<string, A[]>();
  for (const a of [...approvals].sort(
    (x, y) => at(x.createdAt) - at(y.createdAt),
  )) {
    const key = approvalGroupKey(a);
    const list = byKey.get(key);
    if (list) list.push(a);
    else byKey.set(key, [a]);
  }
  return [...byKey.entries()].map(([key, members]) => {
    const counts = new Map<string, number>();
    for (const a of members) {
      const action = actionOf(a);
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1]);
    const [mainAction] = ranked[0] ?? ["request"];
    const deadlines = members.map((a) => at(a.expiresAt)).filter((t) => t > 0);
    return {
      key,
      approvals: members,
      label: members.find((a) => a.batch?.label)?.batch?.label ?? null,
      total: members[0]?.batch?.total ?? null,
      mainAction,
      otherActions: ranked
        .slice(1)
        .map(([action, count]) => ({ action, count })),
      expiresAt: deadlines.length ? Math.min(...deadlines) : null,
    };
  });
};

/** The requests in a group whose action is not the main one: shown first
 *  and flagged, so an odd one (a delete among creates) can't hide. */
export const isOddOneOut = (
  group: ApprovalGroup<GroupableApproval>,
  a: GroupableApproval,
): boolean => actionOf(a) !== group.mainAction;
