import { escapeSlackText } from "@onecli/channels/slack";

/**
 * Slack `table` blocks → text the agent can read.
 *
 * A table pasted into Slack (spreadsheet cells; the client turns them into a
 * Block Kit `table` block) is not in the message's `text`, which carries only
 * the prose typed around it. A pasted table arrives in `attachments[].blocks`
 * (observed from the desktop client); an app-posted one sits in top-level
 * `blocks`. Reading `text` alone handed the agent "add them to the campaign"
 * with no "them".
 *
 * Each table becomes one line per row, cells joined by ` | `, written in the
 * grammar of `text` itself: literal characters escaped (`&amp;`, `&lt;`,
 * `&gt;`) and real mention elements as tokens (`<@U…>`, `<#C…>`,
 * `<url|label>`). The inbound decoder then treats a table exactly like typed
 * text: a mention element becomes a name, and text that merely looks like a
 * token (`<!channel>` typed into a cell) stays text.
 *
 * Parsed loosely and never throws: a block shape Slack adds later must not
 * drop the message it rides on.
 */

/** Slack's table limits (docs.slack.dev, table block). */
const MAX_ROWS = 100;
const MAX_CELLS_PER_ROW = 20;
/** Real cells nest at most 4 levels (rich_text > list > section > element);
 * the bound keeps a hostile, deeply nested cell from exhausting the stack. */
const MAX_RICH_TEXT_DEPTH = 8;
/** The rendered text of all tables in one message. Slack caps a message's
 * cells at 10,000 characters; rendering adds separators and escaping, and
 * this holds even for a payload that ignores Slack's own limit. */
export const MAX_TABLE_TEXT_CHARS = 20_000;
export const TABLE_TRUNCATED_MARKER = "… [table truncated]";

/** Containers whose children are separate lines: a cell's paragraphs and a
 * list's items (sections, quotes and code blocks hold inline runs). */
const LINE_CONTAINERS: ReadonlySet<string> = new Set([
  "rich_text",
  "rich_text_list",
]);

/** A Slack id (`U…`, `C…`, `S…`). */
const SLACK_ID = /^[A-Z][A-Z0-9]+$/;
const BROADCAST_RANGE = /^(here|channel|everyone)$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A token from a validated field, or nothing: no field can smuggle `>` or
 * `|` into the token it becomes. */
const token = (
  value: unknown,
  pattern: RegExp,
  spell: (field: string) => string,
): string => {
  const field = str(value);
  return field && pattern.test(field) ? spell(field) : "";
};

/**
 * One cell, or one rich-text element inside it, in `text` grammar. Walked by
 * hand with a depth bound rather than a recursive schema, so no input shape
 * can recurse without limit.
 */
const renderElement = (element: unknown, depth: number): string => {
  if (!isObject(element) || depth > MAX_RICH_TEXT_DEPTH) return "";
  switch (element.type) {
    case "user":
      return token(element.user_id, SLACK_ID, (id) => `<@${id}>`);
    case "channel":
      return token(element.channel_id, SLACK_ID, (id) => `<#${id}>`);
    case "usergroup":
      return token(element.usergroup_id, SLACK_ID, (id) => `<!subteam^${id}>`);
    case "broadcast":
      return token(element.range, BROADCAST_RANGE, (range) => `<!${range}>`);
    case "emoji": {
      const name = str(element.name);
      return name ? `:${escapeSlackText(name)}:` : "";
    }
    case "date":
      // The text Slack shows where it cannot format the date.
      return escapeSlackText(str(element.fallback) ?? "");
    case "color":
      return escapeSlackText(str(element.value) ?? "");
    case "raw_number": {
      const shown = str(element.text);
      if (shown) return escapeSlackText(shown);
      return typeof element.value === "number" ? String(element.value) : "";
    }
  }
  if (Array.isArray(element.elements)) {
    const separator =
      typeof element.type === "string" && LINE_CONTAINERS.has(element.type)
        ? "\n"
        : "";
    return element.elements
      .map((child) => renderElement(child, depth + 1))
      .join(separator);
  }
  // A leaf: `raw_text`, `text`, `link`, and the labelled elements Slack keeps
  // adding (file, canvas, citation, tag, ...) read as their text, linked
  // when they carry a url.
  const text = str(element.text);
  const url = str(element.url);
  if (url) {
    return text
      ? `<${escapeSlackText(url)}|${escapeSlackText(text)}>`
      : `<${escapeSlackText(url)}>`;
  }
  return text ? escapeSlackText(text) : "";
};

/** A cell on one line: its own line breaks become spaces, so one row stays
 * one line and the table keeps its shape. */
const renderCell = (cell: unknown): string =>
  renderElement(cell, 0).replace(/\s+/g, " ").trim();

const renderTable = (block: unknown): string => {
  if (!isObject(block) || block.type !== "table") return "";
  if (!Array.isArray(block.rows)) return "";
  return block.rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .slice(0, MAX_ROWS)
    .map((row) => row.slice(0, MAX_CELLS_PER_ROW).map(renderCell).join(" | "))
    .join("\n");
};

/** Every block where a table can sit: top-level `blocks`, then each
 * attachment's `blocks`. */
const tableCandidates = (blocks: unknown, attachments: unknown): unknown[] => [
  ...(Array.isArray(blocks) ? blocks : []),
  ...(Array.isArray(attachments) ? attachments : []).flatMap((attachment) =>
    isObject(attachment) && Array.isArray(attachment.blocks)
      ? attachment.blocks
      : [],
  ),
];

/**
 * The text the agent receives for a Slack message: what was typed, then
 * every table it carries, bounded at `MAX_TABLE_TEXT_CHARS`.
 */
export const messageText = (message: {
  text?: string;
  blocks?: unknown;
  attachments?: unknown;
}): string => {
  const typed = message.text ?? "";
  const tables = tableCandidates(message.blocks, message.attachments)
    .map(renderTable)
    .filter((table) => table.trim() !== "")
    .join("\n\n");
  if (!tables) return typed;
  const bounded =
    tables.length <= MAX_TABLE_TEXT_CHARS
      ? tables
      : `${tables.slice(0, MAX_TABLE_TEXT_CHARS)}\n${TABLE_TRUNCATED_MARKER}`;
  return typed ? `${typed}\n\n${bounded}` : bounded;
};
