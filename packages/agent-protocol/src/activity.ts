/**
 * Strip control characters (keeping nothing but printable text), the Unicode
 * line/paragraph separators U+2028/U+2029, and the BIDI FORMATTING controls.
 *
 * The bidi set matters here in a way it does not for a stored document: an
 * activity line is a short status rendered beside the agent's name, so a
 * planted U+202E (right-to-left override) visually REVERSES the rest of the
 * row — letting sandbox-authored text spoof a different message than the one
 * an operator would read back from the transcript. The characters carry no
 * meaning in a one-line status, so they are dropped rather than escaped.
 *
 * Deliberately a LOCAL copy of `memory-file`'s `stripControl` rather than an
 * import: this module is CLIENT-REACHABLE (the web chat's transcript fold
 * renders the activity line), and `memory-file` pulls in `node:crypto` for
 * its checksum helper — importing it here would drag a Node builtin into the
 * browser bundle.
 *
 * Newlines are NOT kept (unlike the memory-file variant): an activity line is
 * single-line by construction, and the caller splits on newlines first.
 */
const stripForStatus = (raw: string): string =>
  [...raw]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      // U+2028/U+2029 line and paragraph separators.
      if (code === 0x2028 || code === 0x2029) return false;
      // Bidi overrides/embeddings (U+202A–U+202E) and isolates
      // (U+2066–U+2069) — the visual-spoofing set.
      if (code >= 0x202a && code <= 0x202e) return false;
      if (code >= 0x2066 && code <= 0x2069) return false;
      return (code >= 0x20 && code !== 0x7f) || ch === "\n";
    })
    .join("");

/**
 * THE ACTIVITY LINE — what the agent is doing *right now*, in a few words.
 *
 * The surfaces show a live caption while a turn runs ("Reading the CI logs",
 * "Running a command") and drop it the moment the answer lands. That caption
 * is derived HERE, once, because two very different consumers need identical
 * semantics: the web chat renders it under the turn, and the Slack adapter
 * sends it as the agent-session work status. A second implementation would
 * drift, and the drift would be user-visible.
 *
 * WHY THIS IS ITS OWN LAW, not a formatting detail:
 *
 * 1. **The text is UNTRUSTED.** Reasoning deltas are model output from a
 *    sandbox that reads the open internet, so a page the agent visits can
 *    influence what appears here. It is bounded, control-stripped, and
 *    single-line by construction — never markup, never a link, never long
 *    enough to be a message. Consumers still render it as TEXT.
 * 2. **It is EPHEMERAL.** Nothing derived here is ever persisted (the delta
 *    law, §3.17): the answer is the record, this is the loader. Keeping the
 *    derivation next to the event vocabulary makes that adjacency obvious.
 * 3. **It is a summary, not a transcript.** Only the FIRST line of a
 *    reasoning block survives (user decision, 2026-08-31): models open a
 *    thinking block with a statement of intent and then digress, so the
 *    opening line is the part that reads like a status while the rest is
 *    the rambling nobody asked to watch.
 */

/**
 * Hard ceiling on a rendered activity line. Slack's status renders on one
 * row beside the app name, and the web's line truncates in a narrow column —
 * past roughly this length both are cutting anyway, so the cut is ours to
 * make deliberately rather than theirs to make arbitrarily.
 */
export const ACTIVITY_TEXT_MAX = 80;

/**
 * What a tool works on, when a run of the same kind can be counted in one
 * phrase ("Ran 3 commands", "Read 2 files"). Tools without one are counted
 * as plain steps.
 */
export type ToolKind = "command" | "read" | "edit" | "fetch" | "search";

interface ToolPhrase {
  /** Present participle, for a call still running ("Reading a file"). */
  running: string;
  /** Past tense, for a finished call ("Read a file"). */
  done: string;
  kind?: ToolKind;
}

/**
 * The tool-name → human phrase map, in both tenses. Deliberately a small
 * allowlist of the tools a reader actually sees, so a line reads as an
 * activity rather than an API call. ONE table for every surface: the live
 * caption (present tense), the chat's finished steps (past tense) and the
 * run header's count (kind) all read it, so they can never disagree on what
 * a tool is called.
 *
 * An UNKNOWN tool falls back to a generic phrase rather than echoing its
 * raw name: tool names come from the sandbox (MCP servers can define their
 * own), so echoing them would put unbounded sandbox-controlled text on
 * every surface for no product gain.
 */
const TOOL_PHRASES: Record<string, ToolPhrase> = {
  bash: {
    running: "Running a command",
    done: "Ran a command",
    kind: "command",
  },
  read: { running: "Reading a file", done: "Read a file", kind: "read" },
  write: { running: "Writing a file", done: "Wrote a file", kind: "edit" },
  edit: { running: "Editing a file", done: "Edited a file", kind: "edit" },
  multiedit: { running: "Editing a file", done: "Edited a file", kind: "edit" },
  agentgrep: {
    running: "Searching the code",
    done: "Searched the code",
    kind: "search",
  },
  ls: { running: "Listing files", done: "Listed files" },
  webfetch: {
    running: "Fetching a page",
    done: "Fetched a page",
    kind: "fetch",
  },
  websearch: {
    running: "Searching the web",
    done: "Searched the web",
    kind: "search",
  },
  // Provider-native search (jcode v0.90+): runs on the model provider's
  // side and surfaces under the provider's tool name.
  web_search: {
    running: "Searching the web",
    done: "Searched the web",
    kind: "search",
  },
  patch: { running: "Applying a patch", done: "Applied a patch", kind: "edit" },
  apply_patch: {
    running: "Applying a patch",
    done: "Applied a patch",
    kind: "edit",
  },
  todo: { running: "Planning the work", done: "Planned the work" },
  swarm: { running: "Coordinating helpers", done: "Coordinated helpers" },
  process_start: {
    running: "Starting background work",
    done: "Started background work",
  },
  process_status: {
    running: "Checking background work",
    done: "Checked background work",
  },
  process_watch: {
    running: "Watching background work",
    done: "Watched background work",
  },
  process_stop: {
    running: "Stopping background work",
    done: "Stopped background work",
  },
  memory_save: { running: "Saving to memory", done: "Saved to memory" },
  memory_get: { running: "Reading its memory", done: "Read its memory" },
  memory_list: { running: "Reading its memory", done: "Read its memory" },
  memory_search: {
    running: "Searching its memory",
    done: "Searched its memory",
    kind: "search",
  },
  schedule_task: { running: "Scheduling a task", done: "Scheduled a task" },
  list_tasks: {
    running: "Checking its schedule",
    done: "Checked its schedule",
  },
  cancel_task: { running: "Cancelling a task", done: "Cancelled a task" },
  list_webhooks: {
    running: "Checking its webhooks",
    done: "Checked its webhooks",
  },
  webhook_runs: {
    running: "Reading a webhook's history",
    done: "Read a webhook's history",
  },
  update_webhook: {
    running: "Asking to change a webhook",
    done: "Asked to change a webhook",
  },
  skill_create: { running: "Writing a skill", done: "Wrote a skill" },
  skill_update: { running: "Updating a skill", done: "Updated a skill" },
  skill_list: { running: "Reading its skills", done: "Read its skills" },
  skill_delete: { running: "Removing a skill", done: "Removed a skill" },
  skill_import: { running: "Installing skills", done: "Installed skills" },
  message_agent: {
    running: "Messaging another agent",
    done: "Messaged another agent",
  },
  find_recipient: { running: "Looking someone up", done: "Looked someone up" },
  read_conversation: {
    running: "Reading a conversation",
    done: "Read a conversation",
  },
  send_message: { running: "Sending a message", done: "Sent a message" },
  send_as_me: {
    running: "Sending as you",
    done: "Sent as you",
  },
  edit_my_message: {
    running: "Editing a message sent as you",
    done: "Edited a message sent as you",
  },
  delete_my_message: {
    running: "Deleting a message sent as you",
    done: "Asked to delete a message sent as you",
  },
  list_my_replies: {
    running: "Looking at its own replies",
    done: "Looked at its own replies",
  },
  edit_my_reply: { running: "Editing its reply", done: "Edited its reply" },
  delete_my_reply: { running: "Deleting its reply", done: "Deleted its reply" },
  send_file: { running: "Sending a file", done: "Sent a file" },
  preview_expose: {
    running: "Asking for a preview link",
    done: "Asked for a preview link",
  },
  request_human_takeover: {
    running: "Asking a person to take over",
    done: "Asked a person to take over",
  },
  complete_task: { running: "Reporting back", done: "Reported back" },
  list_apps: { running: "Checking its apps", done: "Checked its apps" },
  request_app_connection: {
    running: "Asking to connect an app",
    done: "Asked to connect an app",
  },
};

/** The phrase for a tool nobody mapped — see TOOL_PHRASES on why we do not
 * echo the raw name. */
const GENERIC_TOOL_PHRASE: ToolPhrase = {
  running: "Using a tool",
  done: "Used a tool",
};

/**
 * The platform prefixes its MCP tools (`mcp__onecli__process_status`), so the
 * lookup strips that prefix before matching — the prefix is plumbing, and a
 * reader should see "Checking background work" either way.
 */
const phraseFor = (name: string): ToolPhrase =>
  TOOL_PHRASES[bareToolName(name).toLowerCase()] ?? GENERIC_TOOL_PHRASE;

/** The activity line for a running tool call ("Running a command"). */
export const activityForTool = (name: string): string =>
  phraseFor(name).running;

/** Act-as-you tools whose line names the conversation from the call's input
 * ("Sent as you to #general"). */
const AS_YOU_TOOLS = new Set([
  "send_as_me",
  "edit_my_message",
  "delete_my_message",
]);

/** Sending tools whose finished line follows the result's outcome: a call
 * that came back held / needs_access / needs_choice sent nothing, so its
 * line must never say "Sent". */
const SEND_TOOLS = new Set([...AS_YOU_TOOLS, "send_message"]);

const MAX_TARGET_CHARS = 60;

/** The agent's own-reply changes: a failed one must never read "Edited". */
const OWN_REPLY_FAILED: Record<string, string> = {
  edit_my_reply: "Couldn't edit its reply",
  delete_my_reply: "Couldn't delete its reply",
};

/** One string field of a JSON object, flattened and capped (untrusted). */
const fieldOf = (raw: string | undefined, key: string): string | null => {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return null;
    const field: unknown = Reflect.get(value, key);
    if (typeof field !== "string") return null;
    const flat = field.replace(/\s+/g, " ").trim();
    if (!flat) return null;
    return flat.length > MAX_TARGET_CHARS
      ? `${flat.slice(0, MAX_TARGET_CHARS - 1)}…`
      : flat;
  } catch {
    return null;
  }
};

const outcomeOf = (output: string | undefined, isError: boolean) => {
  if (isError) return "failed" as const;
  const status = fieldOf(output, "status");
  switch (status) {
    case "held":
      return "held" as const;
    case "needs_access":
    case "needs_choice":
      return "needs_input" as const;
    case "not_sent":
      return "not_sent" as const;
    default:
      return "done" as const;
  }
};

/** What a sending call targets: the conversation (as-you tools) or `to`. */
const targetOf = (bare: string, input: string | undefined) =>
  AS_YOU_TOOLS.has(bare)
    ? fieldOf(input, "conversation")
    : fieldOf(input, "to");

/** The verb a not-done line names, per tool. */
const ACTION_WORDS: Record<string, { what: string; asYou: string }> = {
  send_message: { what: "send", asYou: "send" },
  send_as_me: { what: "send", asYou: "send as you" },
  edit_my_message: { what: "edit a message", asYou: "edit a message" },
  delete_my_message: { what: "delete a message", asYou: "delete a message" },
};

/**
 * A tool call's line with its input (and, once finished, its result) when
 * that says more. The sending tools name their target and say what really
 * happened: "Sent as you to #general", "Waiting for your approval: send as
 * you to #general", "Needs your input: send to @Sam", "Couldn't send to
 * @Sam". Every other tool reads its plain phrase. Input and output are
 * untrusted model/tool text: callers render the result as text only.
 */
export const activityForToolCall = (
  name: string,
  input: string | undefined,
  running: boolean,
  result?: { output?: string; isError?: boolean },
): string => {
  const phrase = phraseFor(name);
  const base = running ? phrase.running : phrase.done;
  const bare = bareToolName(name).toLowerCase();
  const ownReplyFailed = OWN_REPLY_FAILED[bare];
  if (ownReplyFailed && !running && result?.isError === true) {
    return ownReplyFailed;
  }
  if (!SEND_TOOLS.has(bare)) return base;
  const target = targetOf(bare, input);
  const words = ACTION_WORDS[bare]!;
  const to = (prep: string) => (target ? ` ${prep} ${target}` : "");
  const prep = bare === "send_as_me" || bare === "send_message" ? "to" : "in";
  if (!running && result) {
    const outcome = outcomeOf(result.output, result.isError === true);
    switch (outcome) {
      case "held":
        return `Waiting for your approval: ${words.asYou}${to(prep)}`;
      case "needs_input":
        return `Needs your input: ${words.what}${to(prep)}`;
      case "not_sent":
        return `Not sent${to(prep)}`;
      case "failed":
        return `Couldn't ${words.what}${to(prep)}`;
      case "done":
        break;
    }
  }
  if (!AS_YOU_TOOLS.has(bare) || !target) return base;
  return `${base}${to(prep)}`;
};

/** What the tool works on, or undefined when it is not one countable kind. */
export const toolKind = (name: string): ToolKind | undefined =>
  phraseFor(name).kind;

/**
 * A tool's name without the harness's MCP server prefix
 * (`mcp__onecli__process_status` -> `process_status`). The prefix is
 * plumbing the harness adds when it advertises a server's tools; every
 * reader that matches on platform tool names (this activity line, the
 * supervisor's per-conversation tool attribution) strips it through this one
 * helper so the two can never disagree on the shape.
 */
export const bareToolName = (name: string): string =>
  name.replace(/^mcp__[^_]+__/, "");

/**
 * The activity line for a reasoning block, or null when there is nothing
 * worth showing.
 *
 * FIRST LINE ONLY, then bounded. A model opens a thinking block with its
 * intent ("Architecting two distinct characters and their arc") and then
 * digresses for paragraphs; the opening line is the status, the rest is the
 * digression. Markdown emphasis and heading marks are stripped rather than
 * rendered — this lands in a status row, not a document.
 *
 * Returns null for empty/whitespace input so callers can distinguish "no
 * activity to show" from "an empty caption", which render differently (the
 * previous line stands vs. a blank row).
 */
export const activityForReasoning = (raw: string): string | null => {
  const firstLine = stripForStatus(raw)
    .split("\n")
    .find((l) => l.trim() !== "");
  if (!firstLine) return null;

  const cleaned = firstLine
    // Leading markdown furniture: heading marks, list bullets, quote marks.
    .replace(/^[\s>#*\-+]+/, "")
    // Inline emphasis/code marks anywhere — the row cannot render them, and
    // showing the literal asterisks reads as a bug.
    .replace(/[*_`]/g, "")
    .trim();
  if (!cleaned) return null;

  if (cleaned.length <= ACTIVITY_TEXT_MAX) return cleaned;
  // Prefer a word boundary in the back half so the cut reads as a clipped
  // phrase; never end on a lone high surrogate (a split emoji renders as a
  // replacement char).
  const window = cleaned.slice(0, ACTIVITY_TEXT_MAX);
  const space = window.lastIndexOf(" ");
  const cut = space > ACTIVITY_TEXT_MAX / 2 ? space : ACTIVITY_TEXT_MAX;
  return `${cleaned
    .slice(0, cut)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd()}…`;
};
