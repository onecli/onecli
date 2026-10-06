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

    expect(result).toEqual({
      sessionId: ID,
      before: 12,
      dropped: 4,
      removedImages: 0,
    });
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
      removedImages: 0,
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

/**
 * The unsupported-image shape, exactly as jcode v0.90.0 stores a `read` of a
 * `.ico`: the tool result, the image block (labelled by extension), and the
 * label text jcode writes right after it.
 */
const ICON_BYTES = "AAABAAEAAgIAAAEAIAA=";
const imageReadTurn = (n: number, mediaType: string): Message[] => [
  {
    id: `message_assistant_${n}`,
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: `toolu_${n}`,
        name: "read",
        input: { file_path: `/workspace/icon-${n}` },
      },
    ],
  },
  {
    id: `message_result_${n}`,
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: `toolu_${n}`,
        content: `Image: /workspace/icon-${n}\nImage sent to model for vision analysis.`,
      },
      { type: "image", media_type: mediaType, data: ICON_BYTES },
      {
        type: "text",
        text: `[Attached image associated with the preceding tool result: /workspace/icon-${n}]`,
      },
    ],
  },
];

describe("healJcodeSession: unsupported images", () => {
  it("replaces a journaled image/x-icon with a note folded into its tool result", () => {
    const before = toolTurn(1);
    const poisoned = imageReadTurn(2, "image/x-icon");
    writeSession({ id: ID, messages: before }, [
      { meta: meta("Active"), append_messages: poisoned },
    ]);

    expect(healJcodeSession(sessions, ID)).toEqual({
      sessionId: ID,
      before: 4,
      dropped: 0,
      removedImages: 1,
    });

    const healed = readSnapshot();
    // The journal that held the image is folded in and gone.
    expect(existsSync(journalPath())).toBe(false);
    expect(healed.messages.slice(0, 3)).toEqual([...before, poisoned[0]]);
    // ONE block left in the result message: the tool result, carrying the
    // note. No image, no orphaned label, no sibling text between results.
    expect(healed.messages[3].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_2",
        content:
          "Image: /workspace/icon-2\nImage sent to model for vision analysis.\n" +
          "[Image removed: image/x-icon is not a format the model accepts. Convert it to PNG or JPEG to view it.]",
      },
    ]);
  });

  it("repairs an unsupported image already saved into the snapshot", () => {
    writeSession({
      id: ID,
      messages: [...toolTurn(1), ...imageReadTurn(2, "image/bmp")],
    });

    expect(healJcodeSession(sessions, ID)?.removedImages).toBe(1);
    expect(JSON.stringify(readSnapshot())).not.toContain('"type":"image"');
    expect(JSON.stringify(readSnapshot())).toContain(
      "[Image removed: image/bmp",
    );
  });

  it("turns a pasted image with no tool result before it into a text note", () => {
    writeSession({
      id: ID,
      messages: [
        {
          id: "message_user_1",
          role: "user",
          content: [
            { type: "image", media_type: "image/tiff", data: ICON_BYTES },
            { type: "text", text: "what is this?" },
          ],
        },
      ],
    });

    healJcodeSession(sessions, ID);

    expect(readSnapshot().messages[0].content).toEqual([
      {
        type: "text",
        text: "[Image removed: image/tiff is not a format the model accepts. Convert it to PNG or JPEG to view it.]",
      },
      // The person's own words are not the tool label: they stay.
      { type: "text", text: "what is this?" },
    ]);
  });

  it("files each note under its own tool result, past a kept image", () => {
    // Two results in one message, the first also holding an accepted image.
    // A standalone note anywhere before the second result would put text
    // ahead of a tool result, which the provider rejects.
    const [useOne, resultOne] = imageReadTurn(1, "image/png");
    const [useTwo, resultTwo] = imageReadTurn(2, "image/bmp");
    const [, iconResult] = imageReadTurn(3, "image/x-icon");
    if (!useOne || !resultOne || !useTwo || !resultTwo || !iconResult) {
      throw new Error("imageReadTurn yields a use and a result");
    }
    writeSession({
      id: ID,
      messages: [
        {
          id: "message_assistant_1",
          role: "assistant",
          content: [...useOne.content, ...useTwo.content],
        },
        {
          id: "message_result_1",
          role: "user",
          // The ico image + its label, then the second tool's result.
          content: [
            ...resultOne.content,
            ...iconResult.content.slice(1),
            ...resultTwo.content,
          ],
        },
      ],
    });

    expect(healJcodeSession(sessions, ID)?.removedImages).toBe(2);
    const content: { type: string; content?: string }[] =
      readSnapshot().messages[1].content;
    expect(content.map((block) => block.type)).toEqual([
      "tool_result",
      "image",
      "text",
      "tool_result",
    ]);
    expect(content[0]?.content).toMatch(/\n\[Image removed: image\/x-icon /);
    expect(content[3]?.content).toMatch(/\n\[Image removed: image\/bmp /);
  });

  it("keeps images in every accepted type", () => {
    writeSession({
      id: ID,
      messages: [
        ...imageReadTurn(1, "image/png"),
        ...imageReadTurn(2, "image/jpeg"),
        ...imageReadTurn(3, "image/gif"),
        ...imageReadTurn(4, "image/webp"),
      ],
    });
    const snapshot = readFileSync(snapshotPath(), "utf8");

    expect(healJcodeSession(sessions, ID)).toBeNull();
    expect(readFileSync(snapshotPath(), "utf8")).toBe(snapshot);
  });

  it("matches the label exactly, as the provider does", () => {
    // jcode's clamp lets a case-only mismatch through unchanged, and the
    // provider's list is exact, so `IMAGE/PNG` wedges like `image/bmp`.
    writeSession({ id: ID, messages: imageReadTurn(1, "IMAGE/PNG") });

    expect(healJcodeSession(sessions, ID)?.removedImages).toBe(1);
  });

  it("repairs a torn checkpoint and an unsupported image in one write", () => {
    const turns = [...toolTurn(1), ...imageReadTurn(2, "image/x-icon")];
    // The torn shape: the snapshot already holds what the journal re-appends.
    writeSession({ id: ID, messages: turns }, [
      { meta: meta("Active"), append_messages: turns.slice(2) },
    ]);

    expect(healJcodeSession(sessions, ID)).toEqual({
      sessionId: ID,
      before: 6,
      dropped: 2,
      removedImages: 1,
    });
    const healed = readSnapshot();
    expect(healed.messages).toHaveLength(4);
    expect(JSON.stringify(healed)).not.toContain('"type":"image"');
    // One repair, one pair of backups.
    expect(
      readdirSync(sessions).filter((name) => name.includes(".pre-heal-")),
    ).toHaveLength(2);
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
