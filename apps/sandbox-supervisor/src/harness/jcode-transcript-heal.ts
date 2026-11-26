import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { INLINE_IMAGE_MEDIA_TYPES } from "@onecli/agent-protocol";
import { log } from "../log";

/**
 * THE TRANSCRIPT HEAL. Runs at every container boot, BEFORE the jcode daemon
 * launches, so nothing else reads or writes the session store while it works.
 * It repairs the two known shapes of a stored transcript that the model
 * provider rejects on EVERY request. A conversation holding either one can
 * never answer again, because jcode replays the whole history each turn.
 *
 * 1. THE TORN CHECKPOINT (issue #1194).
 *
 * jcode persists a conversation as a snapshot (`sessions/<id>.json`, written
 * by atomic rename) plus an append-only journal (`<id>.journal.jsonl`) whose
 * entries are replayed onto the snapshot at load. A checkpoint folds the
 * journal into a fresh snapshot in TWO steps: write the snapshot, then delete
 * the journal. The daemon's SIGTERM handler is a bare `process::exit(0)`, so
 * a container stop that lands between the steps leaves a snapshot that
 * ALREADY holds the journal's messages next to a journal that still exists.
 * The next load replays the journal on top, every journaled message appears
 * twice, and the next save makes that permanent. (jcode v0.81.1
 * `session/persistence.rs` `checkpoint_snapshot` + `load_from_path`;
 * unchanged through v0.90.0. v0.90.1 closes this upstream, #1632: replay
 * skips journal entries whose messages the snapshot already holds, a
 * duplicated snapshot is deduped by message id at load, and the SIGTERM
 * handler drains in-flight saves for up to 5 s before exiting.)
 *
 * The duplicate is fatal: jcode's Anthropic formatter dedupes repeated
 * `tool_result` blocks but not repeated `tool_use` blocks, so the second
 * copy of every assistant turn in the replayed span loses its results and the
 * provider rejects EVERY later request (`tool_use ids were found without
 * tool_result blocks immediately after`). In production one stop re-applied
 * a 64-message journal and the conversation never answered again.
 *
 * 2. THE UNSUPPORTED IMAGE (upstream: github.com/1jehuang/jcode/issues/1712).
 *
 * jcode's `read` tool turns `.bmp`/`.ico` files into image blocks labelled
 * `image/bmp`/`image/x-icon` (drag-and-drop paste adds `image/tiff`), and its
 * outbound clamp only reconciles among the four formats providers accept. The
 * provider rejects the block (`…image.source.base64.media_type: Input should
 * be 'image/jpeg', …`) on that request and every one after it, so an agent
 * that opens a favicon can never answer again. (jcode v0.90.0
 * `tool/read.rs`, `provider/image_clamp.rs`. v0.90.1 closes this upstream,
 * #1712: `read` sniffs the bytes and converts BMP/ICO/TIFF to PNG before
 * attaching, and a provider's image rejection strips every stored image and
 * retries.)
 *
 * Both shapes are therefore fixed at the source from v0.90.1 on. This heal
 * stays, as defence in depth and for the stores written under earlier pins:
 * it runs before the daemon launches, so a transcript torn or poisoned under
 * an older runtime is clean before upstream's own repair paths ever see it,
 * and a future regression of either upstream fix is contained the same way.
 *
 * Each repair is deliberately narrow, because it rewrites a person's
 * conversation. Repeats are dropped only when an id repeats with BYTE-
 * IDENTICAL content: a torn checkpoint produces exactly that and nothing else
 * does (ids are `message_<ms>_<random u64>`, minted once). Images are dropped
 * only when their `media_type` is outside the accepted set, never re-encoded,
 * and each leaves a note in its place, so the model knows a picture was
 * there and how to view it again. Anything else (a repeated id with different
 * content, a journal line that is not a clean entry, a symlinked file) leaves
 * the session exactly as found, for jcode's own load to handle.
 */

const SESSIONS_DIRNAME = "sessions";
const SNAPSHOT_SUFFIX = ".json";
const JOURNAL_SUFFIX = ".journal.jsonl";

/** jcode's `SessionJournalEntry` vectors and the session field each one
 * appends to (`apply_journal_entry`). Omitted from a line when empty. The
 * repair deletes the journal, so all four must land in the snapshot. */
const JOURNAL_APPENDS = [
  ["append_messages", "messages"],
  ["append_env_snapshots", "env_snapshots"],
  ["append_memory_injections", "memory_injections"],
  ["append_replay_events", "replay_events"],
] as const;

type JsonObject = { [key: string]: unknown };

export interface TranscriptHealResult {
  sessionId: string;
  /** Messages in the loaded (unrepaired) transcript. */
  before: number;
  /** Repeated messages removed (a torn checkpoint). */
  dropped: number;
  /** Image blocks removed for a media type the provider rejects. */
  removedImages: number;
}

/** What the model providers accept as an image: the same four types inline
 * vision is limited to, so the two lists cannot drift. */
const ACCEPTED_IMAGE_MEDIA_TYPES = new Set(INLINE_IMAGE_MEDIA_TYPES);

/** jcode's label for an image a TOOL attached: a text block written straight
 * after the image (`agent/tools.rs` `tool_output_to_content_blocks`). It
 * describes the image, so it goes with it. */
const TOOL_IMAGE_LABEL_PREFIX =
  "[Attached image associated with the preceding tool result";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The session as jcode's `load_from_path` builds it: the snapshot, then for
 * each journal line its `meta` fields assigned and its vectors appended.
 * Null when anything is not the shape jcode writes (jcode salvages torn or
 * glued lines its own way; this repair never second-guesses that).
 *
 * Plain `JSON.parse` round-trips these files exactly: every number jcode
 * stores in a session (token counts, durations, pids) is far below 2^53.
 */
const loadAsJcodeDoes = (
  snapshotText: string,
  journalText: string | undefined,
): { session: JsonObject; messages: unknown[] } | null => {
  const session: unknown = JSON.parse(snapshotText);
  if (!isObject(session)) return null;
  for (const line of (journalText ?? "").split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isObject(entry) || !isObject(entry.meta)) return null;
    Object.assign(session, entry.meta);
    for (const [appendKey, field] of JOURNAL_APPENDS) {
      const appended = entry[appendKey];
      if (appended === undefined) continue;
      const current = session[field] ?? [];
      if (!Array.isArray(appended) || !Array.isArray(current)) return null;
      session[field] = [...current, ...appended];
    }
  }
  const messages = session.messages;
  return Array.isArray(messages) ? { session, messages } : null;
};

/**
 * The transcript with every byte-identical repeat of an earlier message id
 * removed. Null when an id repeats with DIFFERENT content: that is not a
 * torn checkpoint, and the repair does not guess.
 */
const withoutExactRepeats = (messages: unknown[]): unknown[] | null => {
  const firstById = new Map<string, unknown>();
  const kept: unknown[] = [];
  for (const message of messages) {
    const id = isObject(message) ? message.id : undefined;
    if (typeof id === "string") {
      if (firstById.has(id)) {
        if (JSON.stringify(firstById.get(id)) !== JSON.stringify(message)) {
          return null;
        }
        continue;
      }
      firstById.set(id, message);
    }
    kept.push(message);
  }
  return kept;
};

const unsupportedImageNote = (mediaType: string): string =>
  `[Image removed: ${mediaType} is not a format the model accepts. Convert it to PNG or JPEG to view it.]`;

/** An image block carrying a media type the provider rejects. Matched
 * exactly, as the provider matches it: jcode's clamp compares labels
 * case-insensitively and sends them unchanged, so `IMAGE/PNG` is refused
 * like `image/bmp`. A block with no string `media_type` is not jcode's image
 * shape and is left alone. */
const isUnsupportedImage = (
  block: unknown,
): block is JsonObject & { media_type: string } =>
  isObject(block) &&
  block.type === "image" &&
  typeof block.media_type === "string" &&
  !ACCEPTED_IMAGE_MEDIA_TYPES.has(block.media_type);

/** jcode's tool result: its `content` is always a string (`ToolResult`). */
const isTextToolResult = (
  block: unknown,
): block is JsonObject & { content: string } =>
  isObject(block) &&
  block.type === "tool_result" &&
  typeof block.content === "string";

/**
 * Every message with each unsupported image replaced by a note, and the count
 * replaced. Only messages that held one are copied; the rest are returned as
 * the same objects.
 *
 * The note goes INTO the nearest earlier `tool_result`'s text when there is
 * one (the result the image was attached to; jcode writes a tool's images
 * right after its result). A standalone text block among a turn's tool
 * results would break the provider's rule that tool results come first,
 * which is also why jcode's formatter folds its own image label. An image
 * with no tool result before it (a pasted one) becomes a text block in its
 * place. The tool label that follows a removed image describes it, so it
 * goes too.
 */
const withoutUnsupportedImages = (
  messages: unknown[],
): { messages: unknown[]; removed: number } => {
  let removed = 0;
  const healed = messages.map((message) => {
    if (!isObject(message) || !Array.isArray(message.content)) return message;
    if (!message.content.some(isUnsupportedImage)) return message;
    const content: unknown[] = [];
    for (let index = 0; index < message.content.length; index++) {
      const block: unknown = message.content[index];
      if (!isUnsupportedImage(block)) {
        content.push(block);
        continue;
      }
      removed++;
      const note = unsupportedImageNote(block.media_type);
      let ownerIndex = content.length - 1;
      while (ownerIndex >= 0 && !isTextToolResult(content[ownerIndex])) {
        ownerIndex--;
      }
      const owner = content[ownerIndex];
      if (isTextToolResult(owner)) {
        content[ownerIndex] = {
          ...owner,
          content: `${owner.content}\n${note}`,
        };
      } else {
        content.push({ type: "text", text: note });
      }
      const next: unknown = message.content[index + 1];
      if (
        isObject(next) &&
        next.type === "text" &&
        typeof next.text === "string" &&
        next.text.startsWith(TOOL_IMAGE_LABEL_PREFIX)
      ) {
        index++;
      }
    }
    return { ...message, content };
  });
  return { messages: healed, removed };
};

/** Symlink-safe atomic replace: a fresh temp file (O_EXCL never follows a
 * planted link) carrying the target's own mode, fsynced, renamed over the
 * target. A reader sees the old bytes or the new ones, never a torn file. */
const replaceAtomically = (path: string, contents: string): void => {
  const tmp = `${path}.heal-${process.pid}`;
  rmSync(tmp, { force: true });
  const fd = openSync(
    tmp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    lstatSync(path).mode & 0o777,
  );
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
};

/**
 * Repair one session when it carries a torn checkpoint's duplicates or an
 * image the provider rejects. Returns what it did, or null when it left the
 * session untouched (the common case).
 */
export const healJcodeSession = (
  sessionsDir: string,
  sessionId: string,
): TranscriptHealResult | null => {
  const snapshotPath = join(sessionsDir, `${sessionId}${SNAPSHOT_SUFFIX}`);
  const journalPath = join(sessionsDir, `${sessionId}${JOURNAL_SUFFIX}`);
  // lstat throughout: a planted symlink is never treated as the real file.
  if (!lstatSync(snapshotPath, { throwIfNoEntry: false })?.isFile()) {
    return null;
  }
  const journal = lstatSync(journalPath, { throwIfNoEntry: false });
  if (journal && !journal.isFile()) return null;

  const loaded = loadAsJcodeDoes(
    readFileSync(snapshotPath, "utf8"),
    journal ? readFileSync(journalPath, "utf8") : undefined,
  );
  if (!loaded) return null;
  const deduped = withoutExactRepeats(loaded.messages);
  if (!deduped) return null;
  const healed = withoutUnsupportedImages(deduped);
  const dropped = loaded.messages.length - deduped.length;
  if (dropped === 0 && healed.removed === 0) return null;

  // The originals stay beside the repair (jcode's own `.bak` pruner ages
  // them out), then the consolidated snapshot lands and the journal it now
  // contains goes: exactly the state a COMPLETED checkpoint leaves, so
  // jcode's next load replays nothing on top.
  const stamp = Date.now();
  copyFileSync(
    snapshotPath,
    join(sessionsDir, `${sessionId}.pre-heal-${stamp}.json.bak`),
    fsConstants.COPYFILE_EXCL,
  );
  if (journal) {
    copyFileSync(
      journalPath,
      join(sessionsDir, `${sessionId}.pre-heal-${stamp}.journal.bak`),
      fsConstants.COPYFILE_EXCL,
    );
  }
  replaceAtomically(
    snapshotPath,
    JSON.stringify({ ...loaded.session, messages: healed.messages }),
  );
  if (journal) rmSync(journalPath);

  return {
    sessionId,
    before: loaded.messages.length,
    dropped,
    removedImages: healed.removed,
  };
};

/**
 * Repair every session in the store. Never throws: it runs in the boot path,
 * and no transcript problem may stop the agent from starting. A session that
 * cannot be read or repaired is logged and left for jcode to load as is.
 */
export const healJcodeTranscripts = (jcodeHome: string): void => {
  const sessionsDir = join(jcodeHome, SESSIONS_DIRNAME);
  if (!lstatSync(sessionsDir, { throwIfNoEntry: false })?.isDirectory()) {
    return;
  }
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith(SNAPSHOT_SUFFIX)) continue;
    const sessionId = name.slice(0, -SNAPSHOT_SUFFIX.length);
    try {
      const healed = healJcodeSession(sessionsDir, sessionId);
      if (healed) log("warn", "healed a jcode transcript", { ...healed });
    } catch (error) {
      log("warn", "jcode transcript heal skipped a session", {
        sessionId,
        error: String(error),
      });
    }
  }
};
