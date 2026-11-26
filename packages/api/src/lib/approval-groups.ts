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
    /** The title split around its record; `verb` is the action without it,
     *  `record` the record's name, `row` the index of its detail row. */
    subject?: { verb?: string; record?: string; row?: number } | null;
    /** The card's rows; a change summary reads the ones beside the record. */
    details?: readonly { label: string; value: string }[];
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

/** Natural order ("Test2" before "Test10"), case-insensitive. */
const byName = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * The order a card lists its rows in, the same on every surface: odd
 * actions first (so they can't hide), then by the record each row names,
 * in natural order, so a reviewer checks "Test01 … Test20" as a list
 * instead of in the order the requests happened to arrive. Rows naming no
 * record keep arrival order, after the named ones.
 */
export const orderGroupRows = <A extends GroupableApproval>(
  group: ApprovalGroup<GroupableApproval>,
  rows: readonly A[],
): A[] =>
  [...rows].sort((x, y) => {
    const odd = Number(isOddOneOut(group, y)) - Number(isOddOneOut(group, x));
    if (odd !== 0) return odd;
    const nx = x.summary?.subject?.record?.trim();
    const ny = y.summary?.subject?.record?.trim();
    if (nx && ny) {
      const named = byName.compare(nx, ny);
      if (named !== 0) return named;
    } else if (nx || ny) {
      return nx ? -1 : 1;
    }
    return at(x.createdAt) - at(y.createdAt);
  });

/** How long a tagged batch may go quiet before Approve all is offered over
 *  what arrived: long enough for a parallel send to land (well under a
 *  second when the agent sends the whole batch at once), short enough that
 *  a batch whose total was a miscount never blocks the reviewer. */
export const BATCH_SETTLE_MS = 8_000;

/** Where a tagged batch stands: still arriving while fewer than its total
 *  have arrived and the newest arrived within `BATCH_SETTLE_MS`. */
export interface BatchArrival {
  /** Requests on the card (decided ones included: they did arrive). */
  arrived: number;
  /** The total the agent tagged, when it gave one. */
  total: number | null;
  /** More are expected and the batch is still active. */
  arriving: boolean;
  /** The total was given, the batch went quiet, and some haven't come:
   *  maybe never, maybe only once this card is decided (`batchArrivalNote`). */
  missing: number;
  /** When `arriving` ends on its own (ms epoch), for a re-render timer. */
  settlesAt: number | null;
}

/**
 * Whether a card should wait for the rest of its batch before offering
 * Approve all, so a reviewer never approves a partial list believing it
 * is the whole task. A count is the agent's claim: it can only ever make
 * the card wait (never approve anything), and only until the batch goes
 * quiet. `arrivedAt` are the arrival times of every request on the card.
 */
export const batchArrival = (
  total: number | null,
  arrivedAt: readonly (string | undefined)[],
  now: number,
): BatchArrival => {
  const arrived = arrivedAt.length;
  if (!total || arrived >= total) {
    return { arrived, total, arriving: false, missing: 0, settlesAt: null };
  }
  const newest = Math.max(0, ...arrivedAt.map(at));
  const settlesAt = newest + BATCH_SETTLE_MS;
  const arriving = now < settlesAt;
  return {
    arrived,
    total,
    arriving,
    missing: arriving ? 0 : total - arrived,
    settlesAt: arriving ? settlesAt : null,
  };
};

/**
 * What a card says about a tagged batch that isn't all here, the same on
 * every surface (plain text; a surface adds its own icon and how its
 * Approve all waits). Null when there is nothing to say.
 *
 * Gone quiet with some missing does NOT mean they failed: an agent whose
 * harness runs one call at a time is blocked on THIS approval, so the rest
 * only leave after it is decided. The copy says that, and still says
 * Approve all covers only what is shown.
 */
export const batchArrivalNote = (arrival: BatchArrival): string | null => {
  if (arrival.arriving) {
    return `${arrival.arrived} of ${arrival.total} here, waiting for the rest…`;
  }
  if (!arrival.missing) return null;
  const rest =
    arrival.missing === 1 ? "The other one" : `The other ${arrival.missing}`;
  return `${arrival.arrived} of ${arrival.total} here. ${rest} may only be sent after you decide ${
    arrival.arrived === 1 ? "this one" : "these"
  }. Approve all covers the ${arrival.arrived} shown.`;
};

/** Most changes a summary lists before the card says "show each request":
 *  past this the rows differ too much for a summary to read as one. */
export const SUMMARY_MAX_CHANGES = 6;
/** Most fields a summary line names ("Title → After · Phone → 1"): a
 *  row that sets more is listed on its own, never cut to fit. */
const SUMMARY_FIELDS = 2;

/** One distinct change in a batch and the records it applies to. */
export interface ChangeLine<A> {
  /** Every field it sets, in their card order: `[["Title", "After"]]`. */
  fields: [label: string, value: string][];
  /** The requests making exactly this change, in card order. */
  rows: A[];
}

/**
 * A batch as the changes it makes, for a card that reads "Title → After ·
 * 20 contacts" instead of twenty near-identical rows. Rows are grouped by
 * EVERY field beside their record (everything but the record's own row), so
 * twenty updates to one value are one line, a reassignment to three owners
 * is three, and two rows never share a line unless they make exactly the
 * same change. `null` when a summary would hide something: a row that names
 * no record, a row that changes nothing visible, a row setting more fields
 * than a line names, or more distinct changes than `SUMMARY_MAX_CHANGES`.
 * Callers then list each request.
 */
export const summarizeChanges = <A extends GroupableApproval>(
  rows: readonly A[],
): ChangeLine<A>[] | null => {
  const lines = new Map<string, ChangeLine<A>>();
  for (const a of rows) {
    const subject = a.summary?.subject;
    if (!subject?.record?.trim()) return null;
    const fields = (a.summary?.details ?? [])
      .filter((_, i) => i !== subject.row)
      .map((d): [string, string] => [d.label, d.value]);
    if (fields.length === 0 || fields.length > SUMMARY_FIELDS) return null;
    const key = JSON.stringify(fields);
    const line = lines.get(key);
    if (line) line.rows.push(a);
    else lines.set(key, { fields, rows: [a] });
  }
  return lines.size > 0 && lines.size <= SUMMARY_MAX_CHANGES
    ? [...lines.values()]
    : null;
};

/** What a batch's records are, singular and lower-case, from its first
 *  request's verb ("Update Contact" → "contact"); "record" when it names
 *  none. The noun a card counts its rows in. */
export const recordNounOf = (a: GroupableApproval | undefined): string =>
  (
    a?.summary?.subject?.verb?.trim().split(/\s+/).slice(1).join(" ") ||
    "record"
  ).toLowerCase();
