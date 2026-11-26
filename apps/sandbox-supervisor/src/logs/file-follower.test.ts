import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileFollower,
  MAX_LINE_BYTES,
  type FileFollower,
} from "./file-follower";

/**
 * The follower against a real directory: every rotation/truncation case is
 * driven through the filesystem, and the poll is invoked directly (`tick`)
 * so no test waits on a timer.
 */

const MATCH = /^app-\d{4}-\d{2}-\d{2}\.log$/;
let followers: FileFollower[] = [];

afterEach(() => {
  for (const follower of followers) follower.stop();
  followers = [];
});

const rig = (opts?: { maxBytesPerTick?: number }) => {
  const dir = mkdtempSync(join(tmpdir(), "follow-"));
  const lines: string[] = [];
  const skips: number[] = [];
  const errors: unknown[] = [];
  let flushes = 0;
  const start = () => {
    const follower = createFileFollower({
      dir,
      match: MATCH,
      onLine: (line) => lines.push(line),
      onFlush: () => (flushes += 1),
      onSkip: (bytes) => skips.push(bytes),
      onError: (error) => errors.push(error),
      pollIntervalMs: 60_000,
      ...(opts?.maxBytesPerTick !== undefined && {
        maxBytesPerTick: opts.maxBytesPerTick,
      }),
    });
    followers.push(follower);
    return follower;
  };
  return {
    dir,
    lines,
    skips,
    errors,
    flushes: () => flushes,
    start,
    file: (name: string) => join(dir, name),
  };
};

describe("file follower", () => {
  it("starts at the END of the current file: a previous boot's lines are never replayed", () => {
    const r = rig();
    writeFileSync(r.file("app-2026-10-01.log"), "old 1\nold 2\n");
    const follower = r.start();
    appendFileSync(r.file("app-2026-10-01.log"), "new 1\n");
    follower.tick();
    expect(r.lines).toEqual(["new 1"]);
  });

  it("reads a file that first appears after start from its beginning", () => {
    const r = rig();
    const follower = r.start();
    follower.tick();
    writeFileSync(r.file("app-2026-10-01.log"), "first\nsecond\n");
    follower.tick();
    expect(r.lines).toEqual(["first", "second"]);
  });

  it("tolerates a directory that does not exist yet, then follows it once created", () => {
    const r = rig();
    rmSync(r.dir, { recursive: true });
    const follower = r.start();
    follower.tick();
    expect(r.errors).toEqual([]);
    mkdirSync(r.dir);
    writeFileSync(r.file("app-2026-10-01.log"), "hello\n");
    follower.tick();
    expect(r.lines).toEqual(["hello"]);
  });

  it("holds a partial line until its newline arrives", () => {
    const r = rig();
    writeFileSync(r.file("app-2026-10-01.log"), "");
    const follower = r.start();
    appendFileSync(r.file("app-2026-10-01.log"), "half a li");
    follower.tick();
    expect(r.lines).toEqual([]);
    appendFileSync(r.file("app-2026-10-01.log"), "ne\r\nnext\n");
    follower.tick();
    expect(r.lines).toEqual(["half a line", "next"]);
  });

  it("rotates to the newest file, draining the previous file's tail first", () => {
    const r = rig();
    writeFileSync(r.file("app-2026-10-01.log"), "");
    const follower = r.start();
    appendFileSync(r.file("app-2026-10-01.log"), "late on day 1\n");
    writeFileSync(r.file("app-2026-10-02.log"), "early on day 2\n");
    follower.tick();
    expect(r.lines).toEqual(["late on day 1", "early on day 2"]);
    appendFileSync(r.file("app-2026-10-02.log"), "more day 2\n");
    follower.tick();
    expect(r.lines.at(-1)).toBe("more day 2");
  });

  it("restarts at 0 when the file is truncated in place", () => {
    const r = rig();
    writeFileSync(r.file("app-2026-10-01.log"), "a long first line\n");
    const follower = r.start();
    truncateSync(r.file("app-2026-10-01.log"), 0);
    appendFileSync(r.file("app-2026-10-01.log"), "after\n");
    follower.tick();
    expect(r.lines).toEqual(["after"]);
  });

  it("reads a REPLACED file (new inode, same name) from its start", () => {
    const r = rig();
    writeFileSync(r.file("app-2026-10-01.log"), "x".repeat(40) + "\n");
    const follower = r.start();
    writeFileSync(r.file("tmp"), "replacement\n");
    renameSync(r.file("tmp"), r.file("app-2026-10-01.log"));
    follower.tick();
    expect(r.lines).toEqual(["replacement"]);
  });

  it("ignores files the pattern does not match", () => {
    const r = rig();
    const follower = r.start();
    writeFileSync(r.file("app-2026-10-01.log.bak"), "nope\n");
    writeFileSync(r.file("other.log"), "nope\n");
    follower.tick();
    expect(r.lines).toEqual([]);
  });

  it("never reads through a symlink the agent planted in the followed directory", () => {
    // The directory is agent-writable: a link named like the newest log
    // must not pipe another file (a secret the supervisor can read) into
    // the shipped log.
    const r = rig();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    const secret = join(outside, "secret");
    writeFileSync(secret, "");
    const follower = r.start();
    writeFileSync(r.file("app-2026-10-01.log"), "real 1\n");
    follower.tick();
    symlinkSync(secret, r.file("app-2026-10-02.log"));
    appendFileSync(secret, "SECRET\n");
    appendFileSync(r.file("app-2026-10-01.log"), "real 2\n");
    follower.tick();
    expect(r.lines).toEqual(["real 1", "real 2"]);
  });

  it("never reads through a symlink swapped over the followed file", () => {
    const r = rig();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    const secret = join(outside, "secret");
    writeFileSync(secret, "SECRET\n");
    const follower = r.start();
    writeFileSync(r.file("app-2026-10-01.log"), "real\n");
    follower.tick();
    rmSync(r.file("app-2026-10-01.log"));
    symlinkSync(secret, r.file("app-2026-10-01.log"));
    follower.tick();
    expect(r.lines).toEqual(["real"]);
    expect(r.lines.join()).not.toContain("SECRET");
  });

  it("bounds a tick: an oversized backlog is skipped forward and reported once", () => {
    const r = rig({ maxBytesPerTick: 64 });
    writeFileSync(r.file("app-2026-10-01.log"), "");
    const follower = r.start();
    appendFileSync(
      r.file("app-2026-10-01.log"),
      `${"z".repeat(500)}\nkept 1\nkept 2\n`,
    );
    follower.tick();
    expect(r.skips).toHaveLength(1);
    expect(r.lines.slice(-2)).toEqual(["kept 1", "kept 2"]);
  });

  it("caps a single line, and never holds an unterminated line without bound", () => {
    const r = rig();
    writeFileSync(r.file("app-2026-10-01.log"), "");
    const follower = r.start();
    appendFileSync(
      r.file("app-2026-10-01.log"),
      "y".repeat(MAX_LINE_BYTES * 2),
    );
    follower.tick();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toHaveLength(MAX_LINE_BYTES);
  });

  it("signals a flush only after a tick that delivered lines", () => {
    const r = rig();
    writeFileSync(r.file("app-2026-10-01.log"), "");
    const follower = r.start();
    follower.tick();
    expect(r.flushes()).toBe(0);
    appendFileSync(r.file("app-2026-10-01.log"), "x\n");
    follower.tick();
    expect(r.flushes()).toBe(1);
  });

  it("stop() drains a final poll and then goes quiet", () => {
    const r = rig();
    writeFileSync(r.file("app-2026-10-01.log"), "");
    const follower = r.start();
    appendFileSync(r.file("app-2026-10-01.log"), "last words\n");
    follower.stop();
    appendFileSync(r.file("app-2026-10-01.log"), "after stop\n");
    follower.tick();
    expect(r.lines).toEqual(["last words"]);
  });
});
