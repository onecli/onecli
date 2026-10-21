import {
  clampHeader,
  clampLabel,
  escapeSlackText,
  GROUP_APPROVE_ACTION,
  GROUP_DENY_ACTION,
  normalizeLines,
  packGroupIds,
  packMessageRef,
  postBlocksMessage,
  rowActionId,
  shareFileWithBlocks,
  SharedMessageUnknownError,
  SlackApiError,
  unpackMessageRef,
  updateBlocksMessage,
} from "@onecli/channels/slack";
import {
  batchArrival,
  batchArrivalNote,
  groupApprovals,
  isOddOneOut,
  orderGroupRows,
  recordNounOf,
  summarizeChanges,
} from "@onecli/api/lib/approval-groups";
import { mergeBatchTables } from "@onecli/api/lib/batch-table";
import {
  BULK_VERBS,
  bulkTitle,
  CHANGE_WORDS,
  cellOpOf,
  changeCounts,
  pluralLabel,
  shownValue,
  UNTOUCHED_CELL,
} from "@onecli/api/lib/record-change";
import type {
  ApprovalCardUi,
  GroupCardView,
  PendingApproval,
} from "../approvals";

/**
 * The Slack rendering of the approvals manager's card seam: Block Kit in,
 * `chat.postMessage`/`chat.update` out. The manager itself (../approvals)
 * stays channel-general — everything Slack-shaped about an approval card
 * lives here.
 */

/** The joined details string stays under Slack's 3,000-char section cap with
 * margin — one oversized card would otherwise kill the whole post with
 * invalid_blocks and silence the approval. */
const DETAILS_BUDGET = 2_800;

/** The leading items whose joined text fits `budget`, kept whole: a cut
 *  mid-item could split an escaped entity or a `<url|text>` link. */
const fitting = (
  items: readonly string[],
  separator: string,
  budget: number,
): string[] => {
  const kept: string[] = [];
  let used = 0;
  for (const item of items) {
    const cost = item.length + (kept.length > 0 ? separator.length : 0);
    if (used + cost > budget) break;
    kept.push(item);
    used += cost;
  }
  return kept;
};

/** A detail value as Slack mrkdwn, linked to its record when it has one.
 *  The URL is already https (checked channel-side in ../approvals); here
 *  only Slack's own `<url|text>` syntax is guarded: a URL carrying `|`, `<`,
 *  `>` or whitespace could break out of it, so it stays plain text. */
const detailValue = (value: string, url: string | undefined): string => {
  const text = clampLabel(escapeSlackText(normalizeLines(value)));
  return url && !/[|<>\s]/.test(url) ? `<${url}|${text}>` : text;
};

/** The quiet line under a card: who is asking, from where, and until when
 *  ("Requested by *Sales bot* · acme.my.salesforce.com · expires 12:45 AM").
 *  Plain words, no emoji, and the host without its port and not in a red
 *  code span: it is context, not a warning. */
const footerLine = (
  agentName: string | undefined,
  host: string | undefined,
  expiresAt: number | null | undefined,
  prefix = "expires",
): string =>
  [
    agentName ? `Requested by *${escapeSlackText(agentName)}*` : null,
    host ? escapeSlackText(host.replace(/:443$/, "")) : null,
    expiresAt
      ? `${prefix} <!date^${Math.floor(expiresAt / 1000)}^{time}|soon>`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** The card. Template text is OURS; every dynamic field is escaped.
 *  `withTable: false` renders a one-record change as the classic detail
 *  rows instead of a table block (a workspace that refuses the block). */
export const approvalCardBlocks = (
  approval: PendingApproval,
  reviewUrl?: string,
  withTable = true,
): unknown[] => {
  const bulk = approval.summary?.bulk;
  if (withTable && bulk?.rows.length === 1 && !approval.batch?.label) {
    return singleRecordCardBlocks(approval, bulk, reviewUrl);
  }
  if (bulk && bulk.rows.length > 1) {
    return bulkCardBlocks(approval, bulk, reviewUrl);
  }
  // Header block is plain_text (Slack cap: 150 chars) — no mrkdwn escaping,
  // no pings possible; just clamp so an unbounded action can't kill the post.
  const headerAction = approval.summary?.action
    ? clampHeader(approval.summary.action)
    : undefined;
  const fallbackTitle = `${escapeSlackText(approval.method ?? "?")} ${escapeSlackText(approval.host ?? "")}${clampLabel(escapeSlackText(approval.path ?? ""))}`;
  const subject = approval.summary?.subject;
  const detailLines = (approval.summary?.details ?? [])
    .slice(0, 8)
    .map((d, i) => {
      // The record the action is about reads by name alone ("Contact:
      // Dana Reyes", linked): its id is noise on a one-record card.
      const value =
        i === subject?.row && subject.record ? subject.record : d.value;
      return `>*${clampLabel(escapeSlackText(normalizeLines(d.label)))}:* ${detailValue(value, d.url).replace(/\n/g, "\n>")}`;
    });
  // Hard section budget: keep whole lines while they fit, and say how many
  // were dropped rather than truncating silently.
  const kept = fitting(detailLines, "\n", DETAILS_BUDGET);
  const dropped = detailLines.length - kept.length;
  if (dropped > 0) kept.push(`>_+${dropped} more_`);
  const details = kept.join("\n");
  const body = headerAction
    ? details
    : `*${fallbackTitle}*${details ? `\n${details}` : ""}`;
  const footer = footerLine(
    approval.agent?.name,
    approval.host,
    approval.expiresAt ? new Date(approval.expiresAt).getTime() : null,
  );

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🛡️ Approval needed${headerAction ? ` · ${headerAction}` : ""}`,
        emoji: true,
      },
    },
    ...(body
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: body },
          },
        ]
      : []),
    ...(footer
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: footer }] }]
      : []),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          action_id: "channel_approve",
          value: approval.id,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          action_id: "channel_deny",
          value: approval.id,
        },
      ],
    },
  ];
};

type Bulk = NonNullable<NonNullable<PendingApproval["summary"]>["bulk"]>;
type BulkRow = Bulk["rows"][number];

/** "Update mailing country (2 of 5)": the agent's own part tag, when it
 *  split a long list into several bulk calls. Agent-claimed, display only. */
const partOf = (
  label: string | undefined,
): { n: number; of: number } | null => {
  const m = /\((\d{1,3}) of (\d{1,3})\)\s*$/.exec(label ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  const of = Number(m[2]);
  return n >= 1 && of > 1 && n <= of ? { n, of } : null;
};

/** One CSV cell: quoted, single line, and never read as a formula by a
 *  spreadsheet the reviewer downloads it into (values are record data). */
const csvCell = (v: string): string => {
  const line = normalizeLines(v).replace(/\s*\n+\s*/g, " ");
  const safe = /^[=+\-@\t\r]/.test(line) ? `'${line}` : line;
  return `"${safe.replaceAll('"', '""')}"`;
};

/** The value a CSV cell holds: the plain value, empty when there is none,
 *  so a spreadsheet can sort and filter it. */
const csvValue = (v: string | null | undefined): string => v ?? "";

/**
 * The full table of a bulk change as a CSV: one row per record (all of
 * them, riskiest first, as the gateway ordered them), one column per field.
 * An update whose current values were read marks each value with what
 * happens to it (🔵 Israel → Canada, 🟢 Canada, 🔴 Israel → empty, ⚪ Canada);
 * a created or deleted record is marked on its name, its values plain.
 * Read-only context columns (a contact's account and title) follow the
 * name, so a reviewer can tell which record each row is.
 */
export const bulkCsv = (bulk: Bulk): string => {
  const kind = bulk.kind ?? "update";
  const compare = kind === "update" && bulk.oldValuesRead === true;
  const context = bulk.context ?? [];
  const header = [
    bulk.objectLabel,
    ...context.map((c) => c.label),
    ...bulk.fields.map((f) => f.label),
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of bulk.rows) {
    const name =
      row.name ??
      (kind === "create"
        ? `New ${bulk.objectLabel.toLowerCase()} ${row.id}`
        : row.id);
    const cells = bulk.fields.map((_, i) => {
      if (kind === "delete") return csvValue(row.old?.[i]);
      const op = cellOpOf(row, i);
      // A field an UPDATE leaves alone is said, never a blank cell (which
      // reads as "set to empty" in a table of changes). A created record
      // has nothing to keep: its unset field stays blank.
      if (op === "untouched") return kind === "update" ? UNTOUCHED_CELL : "";
      if (!compare) return csvValue(row.new[i]);
      const dot = CHANGE_WORDS[op].dot;
      return op === "overwrite" || op === "clear"
        ? `${dot} ${shownValue(row.old?.[i])} → ${shownValue(row.new[i])}`
        : `${dot} ${shownValue(row.new[i])}`;
    });
    lines.push(
      [
        `${kindCopy(bulk).dot}${name}`,
        ...context.map((_, i) => csvValue(row.context?.[i])),
        ...cells,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
};

/** The words for what a change does to its records, in one place; a
 *  created or deleted record carries its dot on its name. */
const KIND_COPY = {
  update: {
    approve: "Approve",
    file: "what each change does",
    dot: "",
  },
  create: {
    approve: "Approve",
    file: "what will be created",
    dot: `${CHANGE_WORDS.fill.dot} `,
  },
  delete: {
    approve: "Delete",
    file: "what will be deleted",
    dot: `${CHANGE_WORDS.clear.dot} `,
  },
} as const;
const kindCopy = (bulk: Bulk) => KIND_COPY[bulk.kind ?? "update"];

/** The CSV's file name: what it is, never a record's data. */
export const bulkCsvName = (bulk: Bulk): string =>
  `${bulk.rows.length}-${bulk.objectLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-changes.csv`;

/** The CSV's title: "20 contacts: what each change does". */
const bulkCsvTitle = (bulk: Bulk): string =>
  `${bulk.rows.length} ${pluralLabel(bulk.objectLabel.toLowerCase(), bulk.rows.length)}: ${kindCopy(bulk).file}`;

/** Slack's cap on the characters across a table's cells is 10,000; rows are
 *  kept whole while they fit under this, the rest named as "+N more". */
const TABLE_BUDGET = 9_000;

/** A table cell: plain text, or one styled run (Slack renders a table
 *  cell's text literally, so nothing in it is escaped or parsed). */
const cell = (
  text: string,
  style?: { bold?: true; italic?: true; strike?: true },
): unknown =>
  style
    ? {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text, style }],
          },
        ],
      }
    : { type: "raw_text", text };

/** A value as a table shows it: one line, never empty (Slack refuses an
 *  empty cell), an empty value said in words. */
const tableText = (v: string | null | undefined): string =>
  shownValue(v ? normalizeLines(v).replace(/\s*\n+\s*/g, " ") : v);

/**
 * One record's fields as a Slack table: Field | Now | New for an update
 * whose current values were read (the old value struck through when it is
 * replaced or cleared, the new one bold), else Field | New (an update), or
 * Field | Value (a created record's values, or what a deleted one holds).
 * `dropped` counts the fields left out past `TABLE_BUDGET`.
 */
const recordTable = (
  bulk: Bulk,
  row: BulkRow,
): { block: unknown; dropped: number } | null => {
  const kind = bulk.kind ?? "update";
  const compare = kind === "update" && bulk.oldValuesRead === true;
  const rows: unknown[][] = [];
  const sizes: number[] = [];
  bulk.fields.forEach((f, i) => {
    const label = tableText(f.label);
    if (kind === "delete") {
      const now = row.old?.[i];
      if (now) rows.push([cell(label), cell(tableText(now))]);
    } else if (kind === "create" || !compare) {
      if (cellOpOf(row, i) === "untouched") return;
      const next = row.new[i];
      rows.push([
        cell(label),
        next ? cell(tableText(next)) : cell("cleared", { italic: true }),
      ]);
    } else {
      const op = cellOpOf(row, i);
      if (op === "untouched") return;
      const now = tableText(row.old?.[i]);
      const next = tableText(row.new[i]);
      const replaced = op === "overwrite" || op === "clear";
      rows.push([
        cell(`${CHANGE_WORDS[op].dot} ${label}`),
        replaced
          ? cell(now, { strike: true })
          : op === "fill"
            ? cell(now, { italic: true })
            : cell(now),
        op === "clear"
          ? cell("cleared", { italic: true })
          : op === "same"
            ? cell("no change", { italic: true })
            : cell(next, { bold: true }),
      ]);
    }
    sizes.push(JSON.stringify(rows.at(-1)).length);
  });
  if (rows.length === 0) return null;
  let used = 0;
  const kept = rows.filter((_, i) => (used += sizes[i]!) <= TABLE_BUDGET);
  const head = compare
    ? ["Field", "Now", "New"]
    : ["Field", kind === "update" ? "New" : "Value"];
  return {
    block: {
      type: "table",
      column_settings: head.map(() => ({ is_wrapped: true })),
      rows: [head.map((h) => cell(h, { bold: true })), ...kept],
    },
    dropped: rows.length - kept.length,
  };
};

/**
 * ONE record created, changed or deleted, as a short card over a Slack
 * table of its fields (`recordTable`): the record named and linked, then
 * Field | Now | New. Each field leads with its change's dot (🔵 updated,
 * 🟢 new, 🔴 cleared, ⚪ no change); the struck-through old value and the
 * bold new one, and "cleared" / "no change" in words, say it again for
 * anyone who can't tell the colors apart. A create or delete is named by
 * the header and the button.
 */
const singleRecordCardBlocks = (
  approval: PendingApproval,
  bulk: Bulk,
  reviewUrl: string | undefined,
): unknown[] => {
  const row = bulk.rows[0]!;
  const kind = bulk.kind ?? "update";
  const read = bulk.oldValuesRead === true;
  const noun = escapeSlackText(bulk.objectLabel.toLowerCase());
  const name = detailValue(
    row.name ??
      approval.summary?.subject?.record ??
      (kind === "create" ? `New ${bulk.objectLabel.toLowerCase()}` : row.id),
    row.url,
  ).replace(/\n+/g, " ");
  const lead =
    kind === "delete"
      ? `*Deletes ${noun}:* ${name}`
      : kind === "create"
        ? `*New ${noun}:* ${name}`
        : `*${escapeSlackText(bulk.objectLabel)}:* ${name}`;
  const table = recordTable(bulk, row);
  const hidden = (bulk.hiddenFields?.length ?? 0) + (table?.dropped ?? 0);
  const notes = [
    ...(kind === "update" && !read
      ? [
          "_Its current values couldn't be read, so this shows the new values only._",
        ]
      : []),
    ...(hidden > 0
      ? [
          `+${hidden} more ${hidden === 1 ? "field" : "fields"}${
            reviewUrl ? `: <${reviewUrl}|see all in OneCLI>` : ""
          }.`,
        ]
      : []),
  ];
  const footer = footerLine(
    approval.agent?.name,
    approval.host,
    approval.expiresAt ? new Date(approval.expiresAt).getTime() : null,
  );
  const headerAction = approval.summary?.action
    ? clampHeader(approval.summary.action)
    : `${BULK_VERBS[bulk.kind ?? "update"]} ${bulk.objectLabel}`;
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🛡️ Approval needed · ${headerAction}`,
        emoji: true,
      },
    },
    { type: "section", text: { type: "mrkdwn", text: lead } },
    ...(table ? [table.block] : []),
    ...(notes.length
      ? [
          {
            type: "context",
            elements: notes.map((text) => ({ type: "mrkdwn", text })),
          },
        ]
      : []),
    ...(footer
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: footer }] }]
      : []),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: kindCopy(bulk).approve },
          action_id: "channel_approve",
          value: approval.id,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          action_id: "channel_deny",
          value: approval.id,
        },
      ],
    },
  ];
};

/**
 * ONE request that changes a whole list of records: one Approve covers all
 * of them, exactly as sent. The card stays short: what changes, how many of
 * each kind in words ("Clears 1 · Updates 1 · Fills 42"), the part when the
 * agent split a long list, and Approve all, plus View table (OneCLI's table
 * of the same change). Every record rides with it as a CSV (`bulkCsv`).
 */
const bulkCardBlocks = (
  approval: PendingApproval,
  bulk: Bulk,
  reviewUrl?: string,
  merged?: MergedBatch,
): unknown[] => {
  const total = bulk.rows.length;
  const read = bulk.oldValuesRead === true;
  const objectNoun = pluralLabel(bulk.objectLabel.toLowerCase(), total);
  const part = merged ? null : partOf(approval.batch?.label);
  const legend =
    bulk.kind === "delete"
      ? `${CHANGE_WORDS.clear.dot} Deletes *${total}*${read ? "" : "   _(their current values couldn't be read)_"}`
      : bulk.kind === "create"
        ? `${CHANGE_WORDS.fill.dot} Creates *${total}*`
        : read
          ? changeCounts(bulk.rows)
              .map(
                ({ op, n }) =>
                  `${CHANGE_WORDS[op].dot} ${CHANGE_WORDS[op].label} *${n}*`,
              )
              .join(" · ")
          : "_Current values couldn't be read, so the table shows new values only._";
  // A create sets many fields: the card names how many, the table lists them.
  const fieldsText =
    bulk.kind === "delete"
      ? ""
      : bulk.kind === "create" && bulk.fields.length > 6
        ? ` · ${bulk.fields.length + (bulk.hiddenFields?.length ?? 0)} fields`
        : ` · ${bulk.fields
            .map((f) => escapeSlackText(normalizeLines(f.label)))
            .join(", ")}`;
  const scope = part
    ? `This approves these ${total} only.${
        part.of > part.n
          ? ` ${part.of - part.n} more ${part.of - part.n === 1 ? "card follows" : "cards follow"}.`
          : ""
      }`
    : merged
      ? `One approval covers all ${total} (${count(merged.ids.length, "request")}), exactly as in the table.`
      : `One approval covers all ${total}, exactly as in the table.`;
  const footer = merged
    ? footerLine(
        approval.agent?.name,
        approval.host,
        merged.expiresAt,
        "first expires",
      )
    : footerLine(
        approval.agent?.name,
        approval.host,
        approval.expiresAt ? new Date(approval.expiresAt).getTime() : null,
      );
  const hidden = bulk.hiddenFields ?? [];
  const hiddenNote = hidden.length
    ? `:warning: The table shows ${bulk.fields.length} of ${bulk.fields.length + hidden.length} fields. Also set, not shown: ${hidden
        .slice(0, 12)
        .map((f) => escapeSlackText(normalizeLines(f)))
        .join(
          ", ",
        )}${hidden.length > 12 ? ` and ${hidden.length - 12} more` : ""}.`
    : null;
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: clampHeader(
          `🛡️ Approval needed · ${bulkTitle(bulk)}${
            part ? ` (part ${part.n} of ${part.of})` : ""
          }`,
        ),
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${total} ${escapeSlackText(objectNoun)}*${fieldsText}\n${legend}`,
      },
    },
    ...(hiddenNote
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: hiddenNote }] }]
      : []),
    ...(merged?.label
      ? [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `The agent says: “${oneLine(merged.label)}”`,
              },
            ],
          },
        ]
      : []),
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: scope },
        ...(footer ? [{ type: "mrkdwn", text: footer }] : []),
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: {
            type: "plain_text",
            text: `${kindCopy(bulk).approve} all ${total}`,
          },
          // A merged batch decides EXACTLY the requests it merged, through
          // the group click (the control plane refuses any id this presence
          // never posted), never one id standing for the rest.
          action_id: merged ? GROUP_APPROVE_ACTION : "channel_approve",
          value: merged ? merged.packedIds : approval.id,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          action_id: merged ? GROUP_DENY_ACTION : "channel_deny",
          value: merged ? merged.packedIds : approval.id,
        },
        // Slack's phone app opens a CSV as plain text, one cell per line;
        // the OneCLI page shows the same table on any screen. A link button
        // (server-built URL, never payload text): its click is no decision,
        // and the adapter ignores its action id.
        ...(reviewUrl
          ? [
              {
                type: "button",
                text: { type: "plain_text", text: "View table" },
                action_id: "channel_view_table",
                url: reviewUrl,
              },
            ]
          : []),
      ],
    },
  ];
};

/** Rows that get their own ⋯ menu; the rest are listed (Slack's 50-block cap
 * and readability both say a card is not a spreadsheet). */
const MENU_ROWS = 15;
const LISTED_ROWS = 35;

/** A tagged batch read as one table, with what its card says beyond the
 *  table: the requests it covers, the agent's label, the first deadline. */
export interface MergedBatch {
  /** The first request: who asked and from where. */
  lead: PendingApproval;
  bulk: Bulk;
  /** Every request merged: exactly what Approve all / Deny decide. */
  ids: string[];
  /** `ids` packed for the group buttons. */
  packedIds: string;
  label: string | null;
  expiresAt: number | null;
}

/**
 * A tagged batch whose every request is itself a list of records, as ONE
 * table and its CSV. The rule is the shared one (`mergeBatchTables`), so
 * the web card and this one always agree; here it also needs the ids to
 * fit one group button. Anything else: null, the group card's rows.
 */
export const mergeBatchBulk = (
  live: readonly PendingApproval[],
): MergedBatch | null => {
  const merged = mergeBatchTables(live);
  const lead = merged?.approvals[0];
  if (!merged || !lead) return null;
  const ids = merged.approvals.map((a) => a.id);
  const packedIds = packGroupIds(ids);
  if (!packedIds) return null;
  return {
    lead,
    bulk: merged.bulk,
    ids,
    packedIds,
    label: merged.label,
    expiresAt: merged.expiresAt,
  };
};

const oneLine = (raw: string): string =>
  clampLabel(escapeSlackText(normalizeLines(raw).replace(/\n+/g, " ")));

/** "1 request" / "3 requests", "2 opportunities". */
const count = (n: number, noun: string): string =>
  `${n} ${pluralLabel(noun, n)}`;

/** `items` joined with `separator`, cut to whole items inside `budget`, with
 *  "+N more" when any were left out. */
const listWithin = (
  items: readonly string[],
  separator: string,
  budget: number,
): string => {
  const kept = fitting(items, separator, budget);
  const left = items.length - kept.length;
  return `${kept.join(separator)}${left > 0 ? `${separator}+${left} more` : ""}`;
};

/** One row's text: the action (when it isn't the card's main one) and the
 *  first two detail values, e.g. "Jane Doe · jane@acme.com". A row that
 *  names its record ("Update Contact Batch Test04") leads with that record
 *  and labels what follows ("Batch Test04 · Title: After"), so the change
 *  never reads like a second name, as on the web card. When another row on
 *  the card names a record of the same name, the lead is the record's own
 *  row, which carries its id, so no two rows read alike. */
const rowText = (
  a: PendingApproval,
  showAction: boolean,
  disambiguate = false,
): string => {
  const subject = a.summary?.subject;
  const all = a.summary?.details ?? [];
  const row = subject?.row;
  const own = row === undefined ? undefined : all[row];
  const lead = subject?.record
    ? [detailValue((disambiguate && own?.value) || subject.record, own?.url)]
    : [];
  const rest = subject?.record
    ? all
        .filter((_, i) => i !== row)
        .slice(0, 1)
        .map((d) =>
          detailValue(`${d.label}: ${d.value}`, d.url).replace(/\n+/g, " "),
        )
    : all
        .slice(0, 2)
        .map((d) => detailValue(d.value, d.url).replace(/\n+/g, " "));
  const details = [...lead, ...rest];
  const action = a.summary?.action ? oneLine(a.summary.action) : undefined;
  const parts = [...(showAction && action ? [`*${action}*`] : []), ...details];
  if (parts.length > 0) return parts.join(" · ");
  return `${escapeSlackText(a.method ?? "?")} ${clampLabel(escapeSlackText(a.path ?? ""))}`;
};

const OUTCOME_ICON = {
  approved: "✅",
  denied: "⛔",
  expired: "⌛",
  decided: "☑️",
} as const;

/**
 * The GROUPED card, and the table its CSV carries when it has one. A batch
 * of record lists reads as the one table it is while none of it is
 * decided (`mergeBatchBulk`); anything else is the card's rows. The one
 * place that decides it, so the blocks and the CSV never disagree.
 */
const groupCard = (
  view: GroupCardView,
): { blocks: unknown[]; table: Bulk | null } => {
  const merged = view.settled.length === 0 ? mergeBatchBulk(view.live) : null;
  return merged
    ? {
        blocks: bulkCardBlocks(
          merged.lead,
          merged.bulk,
          view.reviewUrl,
          merged,
        ),
        table: merged.bulk,
      }
    : { blocks: rowsCardBlocks(view), table: null };
};

export const groupCardBlocks = (view: GroupCardView): unknown[] =>
  groupCard(view).blocks;

/**
 * The grouped card as rows: one message for one task's approvals. Every row
 * is its own held request; Approve all / Deny all carry EXACTLY the live ids
 * shown (the control plane refuses any id not posted on this presence). A
 * row whose action differs from the card's main one is pinned first and
 * flagged, so a delete among creates can't hide. Template text is ours;
 * every dynamic field is escaped, and the agent's batch label/total are
 * shown as the agent's claim.
 */
const rowsCardBlocks = (view: GroupCardView): unknown[] => {
  const [group] = groupApprovals(view.live);
  // Odd actions first, then by record name: the same order the web lists.
  const live = group ? orderGroupRows(group, group.approvals) : [];
  const nameCounts = new Map<string, number>();
  for (const a of live) {
    const name = a.summary?.subject?.record;
    if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const sharesName = (a: PendingApproval): boolean =>
    (nameCounts.get(a.summary?.subject?.record ?? "") ?? 0) > 1;
  const main = group?.mainAction ?? view.settled[0]?.title ?? "Requests";
  const label =
    group?.label ?? view.settled.find((s) => s.label)?.label ?? null;
  const total = group?.total ?? null;
  const agentName = view.live[0]?.agent?.name;
  const host = view.live[0]?.host;
  const blocks: unknown[] = [];

  const doneCounts = { approved: 0, denied: 0, expired: 0, decided: 0 };
  for (const s of view.settled) doneCounts[s.outcome] += 1;
  const doneLine = (Object.keys(doneCounts) as (keyof typeof doneCounts)[])
    .filter((k) => doneCounts[k] > 0)
    .map((k) => `${OUTCOME_ICON[k]} ${doneCounts[k]} ${k}`)
    .join(" · ");

  if (live.length === 0) {
    const by = [
      ...new Set(
        view.settled.flatMap((s) => (s.by ? [escapeSlackText(s.by)] : [])),
      ),
    ];
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${oneLine(label ?? main)}* · ${count(view.settled.length, "request")}\n${doneLine}${
            by.length ? ` · by ${listWithin(by, ", ", DETAILS_BUDGET)}` : ""
          }`,
        },
      },
    ];
  }

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: clampHeader(
        `🛡️ ${count(live.length, "approval")} needed · ${main}`,
      ),
      emoji: true,
    },
  });
  if (label || total) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `The agent says: ${label ? `“${oneLine(label)}”` : "one task"}${
            total ? ` · ${count(total, "request")} in total` : ""
          }`,
        },
      ],
    });
  }
  const odd = group?.otherActions ?? [];
  if (odd.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: *Not all the same:* ${listWithin(
          odd.map((o) => `${o.count} × ${oneLine(o.action)}`),
          ", ",
          DETAILS_BUDGET,
        )}. Those are listed first.`,
      },
    });
  }

  // A batch that reads as a few changes is shown as just those changes
  // ("*Title → After* · 20 contacts" and every record, linked), as the web
  // card shows it, with Approve all / Deny all. Deciding row by row is the
  // web card's job (`reviewUrl`). Never past an odd action, a decided row,
  // when the summary would not shorten the card, or when a name would be
  // cut (Approve all only ever covers records the reviewer can see).
  const changes =
    live.length > 1 && odd.length === 0 && view.settled.length === 0
      ? summarizeChanges(live)
      : null;
  const noun = recordNounOf(live[0]);
  const nameOf = (a: PendingApproval): string => {
    const own =
      a.summary?.subject?.row === undefined
        ? undefined
        : a.summary.details?.[a.summary.subject.row];
    return detailValue(
      (sharesName(a) && own?.value) || a.summary?.subject?.record || "",
      own?.url,
    );
  };
  const summary = changes?.map((line) => ({
    change: line.fields
      .map(([label, value]) => `${oneLine(label)} → ${oneLine(value)}`)
      .join(" · "),
    count: line.rows.length,
    names: line.rows.map(nameOf),
  }));
  const summarized =
    summary !== undefined &&
    summary.length < live.length &&
    summary.every(
      (line) =>
        fitting(line.names, ", ", DETAILS_BUDGET / summary.length).length ===
        line.names.length,
    );
  if (summarized) {
    const text = summary
      .map(
        (line) =>
          `*${line.change}* · ${count(line.count, noun)}\n${line.names.join(", ")}`,
      )
      .join("\n\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text } });
    if (view.reviewUrl) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `To decide one at a time, <${view.reviewUrl}|review each request in OneCLI>.`,
          },
        ],
      });
    }
  }

  const rows = summarized ? [] : live;
  rows.slice(0, MENU_ROWS).forEach((a, i) => {
    const flagged = group ? isOddOneOut(group, a) : false;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${flagged ? ":warning: " : ""}${rowText(a, flagged, sharesName(a))}`,
      },
      accessory: {
        type: "overflow",
        action_id: rowActionId(i),
        options: [
          {
            text: { type: "plain_text", text: "Approve this one" },
            value: `approve|${a.id}`,
          },
          {
            text: { type: "plain_text", text: "Deny this one" },
            value: `deny|${a.id}`,
          },
        ],
      },
    });
  });
  // Approve all covers ONLY rows the card shows: every summarized row is
  // named, else the listed ones. Rows past what fits stay pending and
  // appear on this card as the shown ones are decided.
  const shownIds = (summarized ? live : live.slice(0, MENU_ROWS)).map(
    (a) => a.id,
  );
  const rest = rows.slice(MENU_ROWS);
  let notShown = 0;
  if (rest.length > 0) {
    const listed = rest.slice(0, LISTED_ROWS);
    const lines = fitting(
      listed.map((a) => `• ${rowText(a, false, sharesName(a))}`),
      "\n",
      DETAILS_BUDGET,
    );
    shownIds.push(...listed.slice(0, lines.length).map((a) => a.id));
    notShown = live.length - shownIds.length;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${lines.join("\n")}${notShown > 0 ? `\n_+${notShown} more waiting. They show here once these are decided, and Approve all never includes them._` : ""}`,
      },
    });
  }

  const footer = footerLine(agentName, host, group?.expiresAt, "first expires");
  blocks.push({
    type: "context",
    elements: [
      ...(footer ? [{ type: "mrkdwn", text: footer }] : []),
      ...(doneLine ? [{ type: "mrkdwn", text: `Done: ${doneLine}` }] : []),
    ],
  });

  const ids = packGroupIds(shownIds);
  // A tagged batch still arriving offers no Approve all yet: the reviewer
  // never approves part of a list believing it is the whole task. Deny all
  // (the safe direction) stays. The manager re-renders the card when the
  // batch completes or goes quiet (`batchSettlesAt`).
  const arrival = batchArrival(
    total,
    [...view.live, ...view.settled].map((a) => a.createdAt),
    view.now ?? Date.now(),
  );
  const note = batchArrivalNote(arrival);
  if (note) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          // Shared copy (ours, no dynamic text). While the batch arrives
          // this card has no Approve all yet, so it says when it comes.
          text: arrival.arriving
            ? `:hourglass_flowing_sand: ${note} Approve all appears once they are in.`
            : note,
        },
      ],
    });
  }
  if (ids) {
    blocks.push({
      type: "actions",
      elements: [
        ...(arrival.arriving
          ? []
          : [
              {
                type: "button",
                style: "primary",
                text: {
                  type: "plain_text",
                  text: `Approve ${notShown > 0 ? "these" : "all"} ${shownIds.length}`,
                },
                action_id: GROUP_APPROVE_ACTION,
                value: ids,
              },
            ]),
        {
          type: "button",
          style: "danger",
          text: {
            type: "plain_text",
            text: `Deny ${notShown > 0 ? "these" : "all"} ${shownIds.length}`,
          },
          action_id: GROUP_DENY_ACTION,
          value: ids,
        },
      ],
    });
  }
  return blocks;
};

/** Slack says the card's message (or its channel) is permanently gone. */
const isGone = (err: unknown): boolean =>
  err instanceof SlackApiError &&
  (err.code === "message_not_found" ||
    err.code === "channel_not_found" ||
    err.code === "is_archived");

export const slackApprovalCardUi: ApprovalCardUi = {
  async renderGroup(input) {
    const live = input.view.live.length;
    const text = live
      ? `${count(live, "approval")} needed`
      : `${count(input.view.settled.length, "request")} decided`;
    const { blocks, table } = groupCard(input.view);
    try {
      await updateBlocksMessage(input.credential, {
        channel: input.channel,
        ts: input.ts,
        text,
        blocks,
        // Once the batch no longer reads as one table (a request decided
        // elsewhere), its CSV goes too: it would list changes no longer
        // asked. A card that still does keeps the CSV it was posted with.
        ...(!table && { fileIds: [] }),
      });
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  },
  packMessageRef: (ref) => packMessageRef(ref.channel, ref.ts),
  unpackMessageRef,
  async post(input) {
    // A tagged batch posts as the batch card with every row that has
    // arrived, so the reviewer never sees a single-request card (or "1 of
    // 20") turn into a batch a moment later.
    const grouped =
      (input.approval.batch?.total ?? 0) > 1
        ? groupCard({
            live: input.batch?.length ? input.batch : [input.approval],
            settled: [],
            ...(input.reviewUrl && { reviewUrl: input.reviewUrl }),
          })
        : null;
    const bulk = grouped ? grouped.table : input.approval.summary?.bulk;
    const blocksFor = (withTable: boolean) =>
      grouped
        ? grouped.blocks
        : approvalCardBlocks(input.approval, input.reviewUrl, withTable);
    // A list of records rides as a CSV IN the card's own message: Slack
    // shows a file only when it is shared with its message (one attached
    // later by chat.update is linked but never shown, measured live).
    if (bulk && bulk.rows.length > 1) {
      try {
        return await shareFileWithBlocks(input.credential, {
          channel: input.channel,
          ...(input.threadTs && { threadTs: input.threadTs }),
          blocks: blocksFor(true),
          file: {
            name: bulkCsvName(bulk),
            title: bulkCsvTitle(bulk),
            bytes: new TextEncoder().encode(bulkCsv(bulk)),
          },
        });
      } catch (err) {
        // The card IS posted, its ts unknown: never post it a second time.
        // Its buttons still decide it; only the in-place settle is lost.
        if (err instanceof SharedMessageUnknownError) throw err;
        // Nothing posted (upload refused, a workspace without files:write):
        // the card alone, below, costs only the CSV.
        console.warn(
          `[approvals] bulk table upload failed, posting the card alone: ${
            err instanceof SlackApiError ? err.code : String(err)
          }`,
        );
      }
    }
    const postWith = (blocks: unknown[]) =>
      postBlocksMessage(input.credential, {
        channel: input.channel,
        text: "Approval needed",
        blocks,
        noUnfurl: true,
        ...(input.threadTs && { threadTs: input.threadTs }),
        ...(input.iconUrl && { iconUrl: input.iconUrl }),
      });
    const posted = await postWith(blocksFor(true)).catch((err: unknown) => {
      // A workspace whose Slack refuses the table block still gets the
      // card: the same change as the classic detail rows.
      if (
        !(err instanceof SlackApiError) ||
        !err.code.startsWith("invalid_blocks")
      ) {
        throw err;
      }
      return postWith(blocksFor(false));
    });
    return { channel: posted.channel, ts: posted.ts };
  },
  async settle(input) {
    // A settled card still says WHAT was asked — a thread of bare outcomes
    // ("Decided", "Decided", "Decided") is unreadable in channel history.
    // The title is one line here: line breaks collapse to spaces.
    const text = input.title
      ? `${escapeSlackText(clampHeader(normalizeLines(input.title).replace(/\n+/g, " ")))} · ${input.text}`
      : input.text;
    try {
      await updateBlocksMessage(input.credential, {
        channel: input.channel,
        ts: input.ts,
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
        // A settled card is one line: a bulk card's CSV goes too (a click's
        // replace already drops it; expiry edits, so it says so).
        fileIds: [],
      });
    } catch (err) {
      // A permanently-gone card counts as settled (the seam contract): it
      // cannot mislead anyone, and retrying chat.update against it every
      // sweep forever would wedge the ledger row pending across restarts.
      if (!isGone(err)) throw err;
    }
  },
};
