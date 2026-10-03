import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  healJcodeSession,
  healJcodeTranscripts,
} from "./jcode-transcript-heal";

/**
 * The torn-checkpoint heal (issue #1194). Fixtures use jcode v0.81.1's own
 * on-disk shapes: a session snapshot `{ id, …, messages: StoredMessage[] }`
 * and journal lines `{ meta, append_messages?, … }`. That is exactly what
 * the production session that bricked looked like.
 */

type Message = { id: string; role: string; content: unknown[] };

const toolTurn = (n: number): Message[] => [
  {
    id: `message_assistant_${n}`,
    role: "assistant",
    content: [
      { type: "tool_use", id: `toolu_${n}`, name: "bash", input: { n } },
    ],
  },
  {
    id: `message_result_${n}`,
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: `toolu_${n}`, content: "ok" },
    ],
  },
];

const meta = (status: string) => ({
  parent_id: null,
  title: null,
  updated_at: "2026-01-01T00:00:00.000000000Z",
  compaction: null,
  status,
  last_pid: 55,
});

let dir: string;
let sessions: string;
const ID = "session_otter_1700000000000_0123456789abcdef";
const snapshotPath = () => join(sessions, `${ID}.json`);
const journalPath = () => join(sessions, `${ID}.journal.jsonl`);
const readSnapshot = () => JSON.parse(readFileSync(snapshotPath(), "utf8"));

const writeSession = (
  snapshot: Record<string, unknown>,
  journalEntries?: Record<string, unknown>[],
) => {
  writeFileSync(snapshotPath(), JSON.stringify(snapshot));
  if (journalEntries) {
    writeFileSync(
      journalPath(),
      journalEntries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
  }
};

let tempDirs: string[] = [];
const tempDir = (prefix: string) => {
  const created = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(created);
  return created;
};

beforeEach(() => {
  dir = tempDir("jcode-heal-");
  sessions = join(dir, "sessions");
  mkdirSync(sessions);
});

afterEach(() => {
  for (const created of tempDirs) {
    rmSync(created, { recursive: true, force: true });
  }
  tempDirs = [];
});

/**
 * The production shape: a checkpoint wrote a snapshot that already holds the
 * journaled turns, the container stopped before the journal was deleted, and
 * the stale journal still appends those same turns at load.
 */
const writeTornCheckpoint = () => {
  const before = [...toolTurn(1), ...toolTurn(2)];
  const journaled = [...toolTurn(3), ...toolTurn(4)];
  writeSession(
    {
      id: ID,
      future_field: { kept: true },
      env_snapshots: [{ reason: "resume" }],
      messages: [...before, ...journaled],
    },
    [
      { meta: meta("Active"), append_messages: journaled.slice(0, 2) },
      {
        meta: meta("Closed"),
        append_messages: journaled.slice(2),
        append_env_snapshots: [{ reason: "set_model" }],
      },
    ],
  );
  return [...before, ...journaled];
};

describe("healJcodeSession", () => {
  it("repairs a torn checkpoint into the state a completed one leaves", () => {
    const expected = writeTornCheckpoint();

    const result = healJcodeSession(sessions, ID);

    expect(result).toEqual({ sessionId: ID, before: 12, dropped: 4 });
    const healed = readSnapshot();
    expect(healed.messages).toEqual(expected);
    // Every tool_use is again followed by its own result: the property the
    // provider enforces and the duplicates broke.
    for (let i = 0; i < healed.messages.length; i += 2) {
      expect(healed.messages[i + 1].content[0].tool_use_id).toBe(
        healed.messages[i].content[0].id,
      );
    }
    // The journal is folded in (meta wins, vectors appended) and removed, so
    // jcode's next load replays nothing on top of the snapshot.
    expect(existsSync(journalPath())).toBe(false);
    expect(healed.status).toBe("Closed");
    expect(healed.env_snapshots).toEqual([
      { reason: "resume" },
      { reason: "set_model" },
    ]);
    // Fields this repair does not know survive untouched.
    expect(healed.future_field).toEqual({ kept: true });
  });

  it("keeps the originals as backups beside the repair", () => {
    writeTornCheckpoint();
    chmodSync(snapshotPath(), 0o644);
    const snapshotBefore = readFileSync(snapshotPath(), "utf8");
    const journalBefore = readFileSync(journalPath(), "utf8");

    healJcodeSession(sessions, ID);

    // The repaired snapshot keeps jcode's own file mode.
    expect(statSync(snapshotPath()).mode & 0o777).toBe(0o644);
    const backups = readdirSync(sessions).filter((name) =>
      name.includes(".pre-heal-"),
    );
    expect(backups).toHaveLength(2);
    const snapshotBackup = backups.find((name) => name.endsWith(".json.bak"));
    const journalBackup = backups.find((name) => name.endsWith(".journal.bak"));
    expect(readFileSync(join(sessions, snapshotBackup ?? ""), "utf8")).toBe(
      snapshotBefore,
    );
    expect(readFileSync(join(sessions, journalBackup ?? ""), "utf8")).toBe(
      journalBefore,
    );
  });

  it("repairs duplicates a previous load already saved into the snapshot", () => {
    // After the first torn boot jcode's next save checkpoints the doubled
    // transcript: no journal any more, the duplicates live in the snapshot.
    const turns = [...toolTurn(1), ...toolTurn(2)];
    writeSession({ id: ID, messages: [...turns, ...turns.slice(2)] });

    expect(healJcodeSession(sessions, ID)).toEqual({
      sessionId: ID,
      before: 6,
      dropped: 2,
    });
    expect(readSnapshot().messages).toEqual(turns);
  });

  it("is idempotent: a repaired session is left alone", () => {
    writeTornCheckpoint();
    healJcodeSession(sessions, ID);
    const repaired = readFileSync(snapshotPath(), "utf8");

    expect(healJcodeSession(sessions, ID)).toBeNull();
    expect(readFileSync(snapshotPath(), "utf8")).toBe(repaired);
  });

  it("never touches a healthy session or its journal", () => {
    const turns = [...toolTurn(1), ...toolTurn(2)];
    writeSession({ id: ID, messages: turns.slice(0, 2) }, [
      { meta: meta("Active"), append_messages: turns.slice(2) },
    ]);
    const snapshot = readFileSync(snapshotPath(), "utf8");
    const journal = readFileSync(journalPath(), "utf8");

    expect(healJcodeSession(sessions, ID)).toBeNull();
    expect(readFileSync(snapshotPath(), "utf8")).toBe(snapshot);
    expect(readFileSync(journalPath(), "utf8")).toBe(journal);
  });

  it("leaves a repeated id with DIFFERENT content alone: not a torn checkpoint", () => {
    const [first, result] = toolTurn(1);
    const edited = { ...first, content: [{ type: "text", text: "changed" }] };
    writeSession({ id: ID, messages: [first, result, edited] });
    const snapshot = readFileSync(snapshotPath(), "utf8");

    expect(healJcodeSession(sessions, ID)).toBeNull();
    expect(readFileSync(snapshotPath(), "utf8")).toBe(snapshot);
  });

  it("leaves a session whose journal has a line jcode would have to salvage", () => {
    writeTornCheckpoint();
    writeFileSync(journalPath(), '{"meta":{"status":"Act', { flag: "a" });
    const snapshot = readFileSync(snapshotPath(), "utf8");

    expect(healJcodeSession(sessions, ID)).toBeNull();
    expect(readFileSync(snapshotPath(), "utf8")).toBe(snapshot);
  });

  it("never follows a planted symlink", () => {
    const outside = tempDir("jcode-heal-outside-");
    const target = join(outside, "victim.json");
    const turns = toolTurn(1);
    writeFileSync(
      target,
      JSON.stringify({ id: ID, messages: [...turns, ...turns] }),
    );
    symlinkSync(target, snapshotPath());

    expect(healJcodeSession(sessions, ID)).toBeNull();
    expect(JSON.parse(readFileSync(target, "utf8")).messages).toHaveLength(4);
  });
});

describe("healJcodeTranscripts", () => {
  it("repairs every torn session and survives one it cannot read", () => {
    writeTornCheckpoint();
    writeFileSync(join(sessions, "session_broken.json"), "{not json");

    expect(() => healJcodeTranscripts(dir)).not.toThrow();
    expect(readSnapshot().messages).toHaveLength(8);
    expect(readFileSync(join(sessions, "session_broken.json"), "utf8")).toBe(
      "{not json",
    );
  });

  it("is a no-op on a home with no session store yet", () => {
    const fresh = tempDir("jcode-heal-fresh-");
    expect(() => healJcodeTranscripts(fresh)).not.toThrow();
  });
});
