import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Follow the newest file in a directory, line by line: `tail -F` for a
 * daily-rotated log, as a small poll loop.
 *
 * Polling (not fs.watch) on purpose: the followed directory lives on the
 * agent's durable home, and inotify semantics across a re-mounted volume,
 * a date-based rotation, and a long-lived process are exactly where
 * watchers silently stop firing. One readdir + stat + one bounded read per
 * tick costs nothing at a one-second cadence.
 *
 * Semantics, each pinned by the test suite:
 * - **Starts at the END** of whatever file is current at creation (the
 *   first poll runs synchronously): the directory is durable across sandbox
 *   restarts, so reading from the head would replay every previous boot's
 *   lines on every boot.
 * - A file that first appears AFTER that poll is read **from its start**:
 *   it is new content by definition (today's file created by this boot).
 * - **Follows the newest file** (the greatest matching name; date-stamped
 *   names sort chronologically), draining the previous file's tail first.
 * - **Survives truncation** (size below the offset → restart at 0) and
 *   **replacement** (inode change → read the new file from 0).
 * - **Only complete lines** are emitted; a trailing partial line is held
 *   until its newline arrives, bounded by MAX_LINE_BYTES.
 * - **Bounded per tick** (`maxBytesPerTick`): a backlog larger than the cap
 *   is skipped forward and reported once through `onSkip`, since the follower
 *   must never become the process's biggest memory or CPU consumer.
 * - **Never throws** into its caller: fs failures go to `onError` and the
 *   next tick retries.
 * - **Never follows a symlink.** The followed directory is agent-writable,
 *   so a planted `jcode-…log -> /some/file` would otherwise pipe any file
 *   this process can read into the shipped log. Only regular files (by
 *   lstat) are followed, and every open is O_NOFOLLOW, so a link swapped in
 *   after the check fails the open instead of being read through.
 */

/** A line longer than this is emitted truncated. */
export const MAX_LINE_BYTES = 16 * 1024;

export interface FileFollowerOptions {
  /** Directory holding the rotated files. */
  dir: string;
  /** Which entries in `dir` are followed (e.g. /^jcode-.*\.log$/). */
  match: RegExp;
  /** One complete line (no trailing newline), in file order. */
  onLine: (line: string) => void;
  /** Called after every tick that delivered at least one line: the point
   * where a consumer assembling multi-line entries can flush its tail. */
  onFlush?: () => void;
  /** Bytes skipped because a tick's backlog exceeded `maxBytesPerTick`. */
  onSkip?: (bytes: number) => void;
  /** A failed fs operation (the follower keeps going). */
  onError?: (error: unknown) => void;
  pollIntervalMs?: number;
  maxBytesPerTick?: number;
}

export interface FileFollower {
  /** Run one poll synchronously (the timer calls this; tests call it directly). */
  tick(): void;
  /** Final poll, then stop; idempotent. */
  stop(): void;
}

interface Position {
  path: string;
  ino: number;
  offset: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_BYTES_PER_TICK = 1024 * 1024;
const OPEN_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

/** lstat, never stat: a symlink is reported as one, never resolved. Only a
 * regular file is followable. */
const regularFile = (path: string) => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isFile() ? stat : undefined;
};

export const createFileFollower = (
  options: FileFollowerOptions,
): FileFollower => {
  const maxBytesPerTick = options.maxBytesPerTick ?? DEFAULT_MAX_BYTES_PER_TICK;
  let initialized = false;
  let position: Position | undefined;
  let pending: Buffer = Buffer.alloc(0);
  let delivered = false;
  let stopped = false;

  const newestPath = (): string | undefined => {
    let names: string[];
    try {
      names = readdirSync(options.dir);
    } catch (error) {
      // The directory not existing YET is the normal state before the
      // harness's first launch.
      if (isErrnoException(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    const newest = names
      .filter(
        (name) =>
          options.match.test(name) &&
          regularFile(join(options.dir, name)) !== undefined,
      )
      .sort()
      .at(-1);
    return newest === undefined ? undefined : join(options.dir, newest);
  };

  const deliver = (line: Buffer): void => {
    delivered = true;
    options.onLine(
      line.subarray(0, MAX_LINE_BYTES).toString("utf8").replace(/\r$/, ""),
    );
  };

  const emit = (chunk: Buffer): void => {
    let data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    let newline = data.indexOf(0x0a);
    while (newline !== -1) {
      deliver(data.subarray(0, newline));
      data = data.subarray(newline + 1);
      newline = data.indexOf(0x0a);
    }
    // An unterminated line is held, but never without bound: at the cap it
    // is flushed as a truncated line so a newline-free writer cannot grow
    // this buffer forever.
    if (data.length >= MAX_LINE_BYTES) {
      deliver(data);
      data = Buffer.alloc(0);
    }
    pending = Buffer.from(data);
  };

  const readFrom = (pos: Position, size: number): void => {
    let start = pos.offset;
    if (size - start > maxBytesPerTick) {
      const skipped = size - start - maxBytesPerTick;
      options.onSkip?.(skipped);
      start += skipped;
      // A held partial line belongs to the skipped region.
      pending = Buffer.alloc(0);
    }
    const length = size - start;
    if (length <= 0) return;
    const buffer = Buffer.alloc(length);
    const fd = openSync(pos.path, OPEN_NOFOLLOW);
    try {
      // The open is the authority: the same inode the position tracks, or
      // nothing (a file swapped between the lstat and the open is skipped).
      if (fstatSync(fd).ino !== pos.ino) return;
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, start + read);
        if (n === 0) break;
        read += n;
      }
      pos.offset = start + read;
      emit(buffer.subarray(0, read));
    } finally {
      closeSync(fd);
    }
  };

  const poll = (): void => {
    const path = newestPath();
    if (!initialized) {
      initialized = true;
      if (path) {
        // The backlog at first sight belongs to a previous boot.
        const stat = regularFile(path);
        if (stat) position = { path, ino: stat.ino, offset: stat.size };
      }
      return;
    }
    if (!path) return;
    const stat = regularFile(path);
    if (!stat) return;

    if (!position) {
      position = { path, ino: stat.ino, offset: 0 };
    } else if (path !== position.path || stat.ino !== position.ino) {
      // Rotated to a new file, or the file was replaced: drain what the
      // previous file still held, then read the new one from its start.
      try {
        const previous = regularFile(position.path);
        if (
          previous &&
          previous.ino === position.ino &&
          previous.size > position.offset
        ) {
          readFrom(position, previous.size);
        }
      } catch {
        // The previous file is gone, and its unread tail with it.
      }
      pending = Buffer.alloc(0);
      position = { path, ino: stat.ino, offset: 0 };
    } else if (stat.size < position.offset) {
      pending = Buffer.alloc(0);
      position.offset = 0;
    }

    if (stat.size > position.offset) readFrom(position, stat.size);
  };

  const tick = (): void => {
    if (stopped) return;
    delivered = false;
    try {
      poll();
    } catch (error) {
      options.onError?.(error);
    }
    if (delivered) options.onFlush?.();
  };

  // The first poll runs NOW, synchronously: it pins the end of whatever a
  // previous boot left, so every line written after this call (even in
  // the first timer interval) is new content and gets read.
  tick();
  const timer = setInterval(
    tick,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  // A follower must never be the reason the process stays alive.
  timer.unref();

  return {
    tick,
    stop() {
      if (stopped) return;
      tick();
      stopped = true;
      clearInterval(timer);
    },
  };
};
