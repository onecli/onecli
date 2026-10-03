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
import { log } from "../log";

/**
 * THE TORN-CHECKPOINT HEAL (issue #1194). Runs at every container boot,
 * BEFORE the jcode daemon launches, so nothing else reads or writes the
 * session store while it works.
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
 * unchanged through v0.89.3.)
 *
 * The duplicate is fatal: jcode's Anthropic formatter dedupes repeated
 * `tool_result` blocks but not repeated `tool_use` blocks, so the second
 * copy of every assistant turn in the replayed span loses its results and the
 * provider rejects EVERY later request (`tool_use ids were found without
 * tool_result blocks immediately after`). In production one stop re-applied
 * a 64-message journal and the conversation never answered again.
 *
 * The repair is deliberately narrow, because it rewrites a person's
 * conversation. A session is touched only when its loaded transcript (the
 * snapshot plus its journal, replayed the way jcode replays it) repeats a
 * message id with BYTE-IDENTICAL content. A torn checkpoint produces exactly
 * that and nothing else does: ids are `message_<ms>_<random u64>`, minted
 * once. Anything else (a repeated id with different content, a journal line
 * that is not a clean entry, a symlinked file) leaves the session exactly as
 * found, for jcode's own load to handle.
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
  /** Messages in the loaded (torn) transcript. */
  before: number;
  /** Repeated messages removed. */
  dropped: number;
}

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
 * Repair one session when it carries a torn checkpoint's duplicates. Returns
 * what it did, or null when it left the session untouched (the common case).
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
  const kept = withoutExactRepeats(loaded.messages);
  if (!kept || kept.length === loaded.messages.length) return null;

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
    JSON.stringify({ ...loaded.session, messages: kept }),
  );
  if (journal) rmSync(journalPath);

  return {
    sessionId,
    before: loaded.messages.length,
    dropped: loaded.messages.length - kept.length,
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
      if (healed) log("warn", "healed a torn jcode transcript", { ...healed });
    } catch (error) {
      log("warn", "jcode transcript heal skipped a session", {
        sessionId,
        error: String(error),
      });
    }
  }
};
