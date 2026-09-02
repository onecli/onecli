import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ATTACHMENTS_ROOT,
  MAX_ATTACHMENT_BYTES,
  type WorkItem,
} from "@onecli/agent-protocol";
import { ensureManagedDir, writeManagedFile } from "./fs";
import { log } from "../log";

type AttachmentPart = Extract<WorkItem, { kind: "attachment.part" }>;

/**
 * Reassemble `attachment.part` frames into files under the `attachments/`
 * managed root. Runs on the SYNC QUEUE (the home-sync chain), which is what
 * gives delivery its ordering guarantee for free: the runner sends every
 * part BEFORE the turn frame on the one socket, the reader chains applies in
 * arrival order, and `runTurn` awaits the chain before starting — a turn can
 * never begin ahead of its files. Failures here are the applier's own (a
 * skipped file fails the agent's read honestly); they must NEVER touch the
 * home-sync generation poison state.
 *
 * ONE reassembly buffer, deliberately: the runner sends each file's frames
 * as an unbroken run, so a single in-progress file bounds memory at
 * MAX_ATTACHMENT_BYTES. Any discontinuity — a different attachment starting,
 * a part out of order, a redelivery restarting at part 1 — resets fail-closed
 * (drop the buffer, keep the disk untouched); the stale-dispatch redelivery
 * re-sends the whole run.
 */
export interface AttachmentAssembler {
  apply(part: AttachmentPart): void;
}

export const createAttachmentAssembler = (
  homeDir: string,
): AttachmentAssembler => {
  let current: {
    attachmentId: string;
    nextPart: number;
    chunks: Buffer[];
    total: number;
  } | null = null;

  const apply = (part: AttachmentPart): void => {
    // Containment: this applier writes ONLY under its managed root. The wire
    // schema already made traversal unrepresentable; this is the braces.
    if (!part.path.startsWith(`${ATTACHMENTS_ROOT}/`)) {
      log("warn", "attachment part outside the managed root; refused", {
        path: part.path,
      });
      return;
    }

    if (part.part === 1) {
      current = {
        attachmentId: part.attachmentId,
        nextPart: 1,
        chunks: [],
        total: 0,
      };
    }
    if (
      !current ||
      current.attachmentId !== part.attachmentId ||
      part.part !== current.nextPart
    ) {
      log("warn", "attachment part out of sequence; dropped", {
        attachmentId: part.attachmentId,
        part: part.part,
      });
      current = null;
      return;
    }

    const chunk = Buffer.from(part.dataBase64, "base64");
    current.total += chunk.byteLength;
    if (
      current.total > MAX_ATTACHMENT_BYTES ||
      current.total > part.sizeBytes
    ) {
      log("warn", "attachment exceeded its declared size; dropped", {
        attachmentId: part.attachmentId,
      });
      current = null;
      return;
    }
    current.chunks.push(chunk);
    current.nextPart += 1;
    if (part.part !== part.of) return;

    const bytes = Buffer.concat(current.chunks);
    current = null;
    if (bytes.byteLength !== part.sizeBytes) {
      log("warn", "attachment size mismatch; not written", {
        attachmentId: part.attachmentId,
      });
      return;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== part.sha256) {
      log("warn", "attachment checksum mismatch; not written", {
        attachmentId: part.attachmentId,
      });
      return;
    }

    ensureManagedDir(homeDir, dirname(part.path));
    // Read-only like every projection; idempotent on redelivery
    // (writeManagedFile unlinks first, symlink-safe by wx).
    writeManagedFile(join(homeDir, part.path), bytes, 0o444);
    log("info", "attachment materialized", {
      path: part.path,
      bytes: bytes.byteLength,
    });
  };

  return { apply };
};

/** How long a turn's attachment files stay on the volume. */
const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Boot sweep: fold up attachment dirs older than the retention window (by
 * mtime — writeManagedFile stamps write time). Symlinks are unlinked as
 * links, never followed; real directories are removed recursively (their
 * contents are this applier's own writes plus whatever the agent copied in,
 * all inside the container's own filesystem).
 */
export const pruneStaleAttachments = (homeDir: string): void => {
  const rootAbs = join(homeDir, ATTACHMENTS_ROOT);
  let entries;
  try {
    entries = readdirSync(rootAbs, { withFileTypes: true });
  } catch {
    return; // no attachments dir yet — nothing to sweep
  }
  const cutoff = Date.now() - ATTACHMENT_RETENTION_MS;
  for (const entry of entries) {
    const abs = join(rootAbs, entry.name);
    try {
      if (entry.isSymbolicLink()) {
        rmSync(abs, { force: true });
        continue;
      }
      const stat = lstatSync(abs, { throwIfNoEntry: false });
      if (!stat || stat.mtimeMs >= cutoff) continue;
      rmSync(abs, { recursive: true, force: true });
    } catch (error) {
      log("warn", "attachment sweep entry failed", {
        entry: entry.name,
        error: String(error),
      });
    }
  }
};

/**
 * Read one materialized attachment back for inline vision, lstat-hardened:
 * regular non-link files only, size re-checked against the manifest (the
 * agent shares the uid and could have swapped the file between apply and
 * turn start — a swap yields `null`, never someone else's bytes inlined).
 */
export const readMaterializedAttachment = (
  homeDir: string,
  relPath: string,
  expected: { sizeBytes: number; sha256: string },
): Buffer | null => {
  if (!relPath.startsWith(`${ATTACHMENTS_ROOT}/`)) return null;
  const abs = join(homeDir, relPath);
  try {
    const stat = lstatSync(abs, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
    if (stat.size !== expected.sizeBytes) return null;
    const bytes = readFileSync(abs);
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      return null;
    }
    return bytes;
  } catch {
    return null;
  }
};
