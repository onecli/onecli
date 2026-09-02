import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureManagedDir, writeManagedFile } from "./fs";
import {
  MAX_MEMORY_WRITE_BYTES,
  MEMORY_DESCRIPTION_MAX_LENGTH,
  MEMORY_FILE_CONTENT_MAX_CHARS,
  MEMORY_TITLE_MAX_LENGTH,
  MEMORY_KEY_MAX_LENGTH,
  MEMORY_KEY_PATTERN,
  isUnmodifiedProjection,
  parseMemoryFile,
  sha256Hex,
  syncFrameByteLength,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import { log } from "../log";

/**
 * The memory harvester — the write-back half of the projection (§3.8 as
 * amended 2026-08-10): agent-authored bytes under `memory/` are uploaded to
 * the platform, which stays the single source of truth; the files are the
 * agent's working copy.
 *
 * The whole design leans on the projection being SELF-AUTHENTICATING (the
 * `checksum:` frontmatter line): a file whose checksum verifies is an
 * unmodified projection and is NEVER uploaded — which is what makes boot
 * scans free (no RPC storm), keeps a stale projection from reverting a newer
 * dashboard edit, and lets a platform-side delete land as a delete instead
 * of being resurrected by its own leftover file.
 *
 * Shape follows processes/observer.ts (the poll-observer precedent): an
 * unref'd non-stacking timer, warn-once sets, and the jcode-background
 * reader's lstat hardening — regular files only, size-gated, bounded scan.
 * All harvest work serializes on ONE internal chain, so a materializer gate
 * (`harvestFile`) and a timer pass can never race each other.
 */

/** Under jcode's 30s like the tool channel: the runner answers in both
 * outcomes, so a silence this long means the answer is not coming. */
export const MEMORY_WRITE_TIMEOUT_MS = 25_000;
export const HARVEST_INTERVAL_MS = 1_500;
/** Paced re-attempt after a retryable refusal (rate pacing, transport). */
export const HARVEST_RETRY_MS = 5_000;
/** Scan bounds — the observer laws: a hostile home must not make a
 * pass unbounded, and a huge file is refused by stat before it is read. */
export const MAX_HARVEST_SCAN_ENTRIES = 256;
export const MAX_HARVEST_FILE_BYTES = 1_000_000;

const MEMORY_ROOT = "memory";
const MEMORY_INDEX_FILE = "index.md";

/**
 * The uploaded-hash LEDGER, persisted on the durable volume (the container
 * is expendable; this map is what makes a crash unambiguous at next boot).
 * Without it, bytes harvested moments before a crash — whose canonical
 * render never made it back — are indistinguishable from a fresh agent
 * write, and a memory a human deleted while the box was down would be
 * RESURRECTED by its own leftover raw file (found live). With it, a boot
 * cache-hit means "the platform absorbed exactly these bytes once", so a
 * manifest-absent file with a known hash is a landed delete.
 *
 * Agent-writable, and deliberately not a trust boundary: forging an entry
 * suppresses the agent's OWN upload (achievable by not writing the file);
 * deleting entries causes a re-upload the platform's no-op dedup absorbs —
 * equivalent to the agent re-saving bytes it can already read.
 */
const HARVEST_STATE_DIR = ".onecli";
const HARVEST_STATE_FILE = "harvest-uploaded.json";
const HARVEST_STATE_MAX_BYTES = 64_000;

/** `deploy-notes.md` → `deploy-notes`, or null when the name can never be a
 * memory key (the file is left alone and steered by the fragment). */
export const memoryKeyOfFileName = (name: string): string | null => {
  if (!name.endsWith(".md") || name === MEMORY_INDEX_FILE) return null;
  const stem = name.slice(0, -3);
  return stem.length <= MEMORY_KEY_MAX_LENGTH && MEMORY_KEY_PATTERN.test(stem)
    ? stem
    : null;
};

export type HarvestOutcome =
  /** An unmodified projection — nothing to upload; prune may delete it. */
  | "pristine"
  /** The platform holds this content (saved now, or already known). */
  | "uploaded"
  /** Refused for THIS content (caps, shape) — re-attempted only when the
   * file changes. The file itself is never touched. */
  | "refused"
  /** Transient failure (pacing, transport, timeout) — re-attempted on the
   * paced clock. */
  | "retry";

type WriteResult = Extract<WorkItem, { kind: "memory.write.result" }>;

export interface MemoryHarvesterOptions {
  homeDir: string;
  send: (message: SupervisorMessage) => void;
  /** First-sight anchoring, exactly like a platform tool call's context. */
  activeTurn: () => { conversationId: string; turnId: string } | null;
  /** Test seams; production uses the defaults. */
  intervalMs?: number;
  timeoutMs?: number;
  retryMs?: number;
}

export interface MemoryHarvester {
  /** One scan pass — exposed for tests; production rides the timer. */
  poll(): Promise<void>;
  /**
   * Harvest one file (name relative to `memory/`) NOW — the materializer's
   * pre-overwrite / pre-prune gate. Serialized with the timer passes.
   */
  harvestFile(fileName: string): Promise<HarvestOutcome>;
  /**
   * Drop all bookkeeping for a file the materializer just removed from disk
   * (a landed platform delete, or a re-projected upload). Load-bearing for
   * the ledger: an entry kept past the file's deletion would make a later
   * byte-identical re-creation hit the "already uploaded" skip — swallowed,
   * no RPC, then pruned again — and would grow the ledger by every dead key
   * (dated logs, rotations) until it crosses its size cap and the
   * crash-resurrection guard silently turns off.
   */
  forgetFile(fileName: string): void;
  /** The reader's inline delivery of a memory.write.result. */
  handleResult(item: WriteResult): void;
  stop(): void;
}

export const createMemoryHarvester = (
  options: MemoryHarvesterOptions,
): MemoryHarvester => {
  const intervalMs = options.intervalMs ?? HARVEST_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? MEMORY_WRITE_TIMEOUT_MS;
  const retryMs = options.retryMs ?? HARVEST_RETRY_MS;
  const memoryDirAbs = join(options.homeDir, MEMORY_ROOT);

  /** Content-hash of what the platform is known to hold, per file — the
   * skip that keeps a settled file from re-uploading every pass, LOADED
   * from and PERSISTED to the volume ledger (see HARVEST_STATE_DIR). */
  const uploadedHash = new Map<string, string>();
  const stateFileAbs = join(
    options.homeDir,
    HARVEST_STATE_DIR,
    HARVEST_STATE_FILE,
  );
  try {
    const stat = lstatSync(stateFileAbs, { throwIfNoEntry: false });
    if (
      stat?.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= HARVEST_STATE_MAX_BYTES
    ) {
      const parsed: unknown = JSON.parse(readFileSync(stateFileAbs, "utf8"));
      if (parsed && typeof parsed === "object") {
        for (const [file, hash] of Object.entries(parsed)) {
          if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) {
            uploadedHash.set(file, hash);
          }
        }
      }
    }
  } catch {
    // A corrupt or missing ledger costs re-uploads the platform no-ops.
  }
  const persistLedger = (): void => {
    try {
      ensureManagedDir(options.homeDir, HARVEST_STATE_DIR);
      writeManagedFile(
        stateFileAbs,
        `${JSON.stringify(Object.fromEntries(uploadedHash))}\n`,
        0o644,
      );
    } catch (error) {
      log("warn", "could not persist the harvest ledger", {
        error: String(error),
      });
    }
  };
  /** Content-hash refused non-retryably, per file — warn-once, retry only
   * on a content change. */
  const refusedHash = new Map<string, string>();
  /** Files whose last attempt was transient — next attempt time. */
  const retryAt = new Map<string, number>();
  /** Scan fast-path: unchanged stat + a settled outcome ⇒ skip the read. */
  const lastStat = new Map<
    string,
    { mtimeMs: number; size: number; settled: boolean }
  >();
  const warnedOnce = new Set<string>();

  const pending = new Map<
    string,
    { resolve: (result: WriteResult | null) => void; timer: NodeJS.Timeout }
  >();

  let stopped = false;
  /** The one serialization chain — every harvest op runs on it. */
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const next = chain.then(op, op);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const warnOnce = (
    key: string,
    message: string,
    context: Record<string, unknown>,
  ): void => {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    log("warn", message, context);
  };

  const sendAndAwait = (
    frame: Extract<SupervisorMessage, { kind: "memory.write" }>,
  ): Promise<WriteResult | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(frame.writeId);
        resolve(null);
      }, timeoutMs);
      timer.unref();
      pending.set(frame.writeId, { resolve, timer });
      options.send(frame);
    });

  /** The unserialized core — callers go through `enqueue`. */
  const harvestNow = async (fileName: string): Promise<HarvestOutcome> => {
    const key = memoryKeyOfFileName(fileName);
    if (!key) return "refused";
    const fileAbs = join(memoryDirAbs, fileName);

    let stat;
    try {
      stat = lstatSync(fileAbs);
    } catch {
      return "refused"; // gone between scan and harvest — nothing to do
    }
    // The jcode-background reader law: never open anything but a regular
    // file (a planted FIFO would wedge this chain forever), never follow a
    // link, never read past the size gate.
    if (!stat.isFile() || stat.isSymbolicLink()) return "refused";
    if (stat.size > MAX_HARVEST_FILE_BYTES) {
      warnOnce(
        `${fileName}:${stat.size}:${stat.mtimeMs}`,
        "memory file too large to harvest; leaving it in place",
        { fileName, size: stat.size },
      );
      lastStat.set(fileName, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        settled: true,
      });
      return "refused";
    }

    let raw: string;
    try {
      raw = readFileSync(fileAbs, "utf8");
    } catch {
      return "retry";
    }

    if (isUnmodifiedProjection(raw)) {
      lastStat.set(fileName, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        settled: true,
      });
      return "pristine";
    }

    const hash = sha256Hex(raw);
    const record = (settled: boolean) =>
      lastStat.set(fileName, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        settled,
      });
    if (uploadedHash.get(fileName) === hash) {
      record(true);
      return "uploaded";
    }
    if (refusedHash.get(fileName) === hash) {
      record(true);
      return "refused";
    }

    const parsed = parseMemoryFile(raw);
    if (parsed.content.length === 0) {
      warnOnce(
        `${fileName}:${hash}`,
        "memory file has no content; not syncing it",
        { fileName },
      );
      refusedHash.set(fileName, hash);
      record(true);
      return "refused";
    }
    if (parsed.content.length > MEMORY_FILE_CONTENT_MAX_CHARS) {
      warnOnce(
        `${fileName}:${hash}`,
        "memory file exceeds the content cap; split it to sync it",
        { fileName, chars: parsed.content.length },
      );
      refusedHash.set(fileName, hash);
      record(true);
      return "refused";
    }

    const turn = options.activeTurn();
    const frame: Extract<SupervisorMessage, { kind: "memory.write" }> = {
      kind: "memory.write",
      writeId: randomUUID(),
      key,
      content: parsed.content,
      // Metadata is a display label — clipped, never a reason to refuse the
      // memory itself.
      ...(parsed.title && {
        title: parsed.title.slice(0, MEMORY_TITLE_MAX_LENGTH),
      }),
      ...(parsed.description && {
        description: parsed.description.slice(0, MEMORY_DESCRIPTION_MAX_LENGTH),
      }),
      ...(turn && {
        conversationId: turn.conversationId,
        turnId: turn.turnId,
      }),
    };
    if (syncFrameByteLength(frame) > MAX_MEMORY_WRITE_BYTES) {
      warnOnce(
        `${fileName}:${hash}`,
        "memory file exceeds the write frame budget; split it to sync it",
        { fileName },
      );
      refusedHash.set(fileName, hash);
      record(true);
      return "refused";
    }

    const result = await sendAndAwait(frame);
    if (result === null) {
      // Timeout — the write MAY have been applied; the checksum law makes a
      // re-send safe (the platform no-ops on equal state).
      retryAt.set(fileName, Date.now() + retryMs);
      record(false);
      return "retry";
    }
    if (result.ok) {
      // The platform holds the bytes we SENT — record them regardless.
      uploadedHash.set(fileName, hash);
      refusedHash.delete(fileName);
      persistLedger();
      log("info", "memory file saved to the platform", {
        fileName,
        created: result.created ?? false,
        noop: result.noop ?? false,
      });
      // But the agent may have written MORE during the round-trip (the read
      // at the top was a snapshot; the upload took real time). If the file
      // changed under us, the bytes now on disk are NOT the bytes we
      // uploaded — so "uploaded" here would let the materializer clobber
      // un-uploaded content. Re-stat: on any change, leave it and re-harvest
      // (the next pass reads the newer bytes). Closes the harvest→clobber
      // data-loss window to the synchronous gap the caller holds.
      const after = lstatSync(fileAbs, { throwIfNoEntry: false });
      if (
        !after ||
        after.mtimeMs !== stat.mtimeMs ||
        after.size !== stat.size
      ) {
        retryAt.set(fileName, Date.now() + retryMs);
        record(false);
        return "retry";
      }
      retryAt.delete(fileName);
      record(true);
      return "uploaded";
    }
    if (result.retryable) {
      retryAt.set(fileName, Date.now() + retryMs);
      record(false);
      return "retry";
    }
    warnOnce(
      `${fileName}:${hash}`,
      "the platform refused this memory file; edit it to re-sync",
      { fileName, error: result.error ?? "refused" },
    );
    refusedHash.set(fileName, hash);
    record(true);
    return "refused";
  };

  const pass = async (): Promise<void> => {
    if (stopped) return;
    let entries;
    try {
      entries = readdirSync(memoryDirAbs, { withFileTypes: true });
    } catch {
      return; // no memory dir yet — the first sync creates it
    }
    const now = Date.now();
    for (const entry of entries.slice(0, MAX_HARVEST_SCAN_ENTRIES)) {
      if (stopped) return;
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const key = memoryKeyOfFileName(entry.name);
      if (!key) {
        if (entry.name !== MEMORY_INDEX_FILE) {
          warnOnce(
            `name:${entry.name}`,
            "file under memory/ has no memory-key name; it will not sync",
            { fileName: entry.name },
          );
        }
        continue;
      }
      const at = retryAt.get(entry.name);
      if (at !== undefined && at > now) continue;
      // Fast path: nothing changed since the last settled look.
      const seen = lastStat.get(entry.name);
      if (seen?.settled) {
        let stat;
        try {
          stat = lstatSync(join(memoryDirAbs, entry.name));
        } catch {
          continue;
        }
        if (stat.mtimeMs === seen.mtimeMs && stat.size === seen.size) continue;
      }
      await harvestNow(entry.name);
    }
  };

  let polling = false;
  const timer = setInterval(() => {
    if (polling) return; // a slow pass never stacks
    polling = true;
    void enqueue(pass).finally(() => {
      polling = false;
    });
  }, intervalMs);
  timer.unref();

  return {
    poll: () => enqueue(pass),
    harvestFile: (fileName) => enqueue(() => harvestNow(fileName)),
    forgetFile(fileName) {
      const had = uploadedHash.delete(fileName);
      refusedHash.delete(fileName);
      retryAt.delete(fileName);
      lastStat.delete(fileName);
      // Persist only when the ledger actually shrank — a delete of a file we
      // never uploaded is a no-op the disk needn't hear about.
      if (had) persistLedger();
    },
    handleResult(item) {
      const waiter = pending.get(item.writeId);
      if (!waiter) return; // timed out already — the paced retry owns it
      pending.delete(item.writeId);
      clearTimeout(waiter.timer);
      waiter.resolve(item);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const [writeId, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
        pending.delete(writeId);
      }
    },
  };
};
