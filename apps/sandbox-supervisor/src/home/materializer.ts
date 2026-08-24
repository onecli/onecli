import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isUnmodifiedProjection,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import { log } from "../log";
import {
  ensureManagedDir,
  isToleratedPruneError,
  pruneManagedRoot,
  writeManagedFile,
} from "./fs";
import { renderHome, type RenderInputs } from "./renderer";
import {
  MAX_HARVEST_FILE_BYTES,
  MAX_HARVEST_SCAN_ENTRIES,
  memoryKeyOfFileName,
  type MemoryHarvester,
} from "./memory-harvest";

/**
 * Apply one part of a home sync (step 9): write the projection files
 * idempotently, and on the FINAL part prune the managed roots to the
 * manifest, refresh the instruction docs from the (possibly updated) render
 * inputs, and ack the generation.
 *
 * Apply-per-part, deliberately (no buffering): parts of one generation
 * arrive in order on the one socket, and generations cannot interleave (the
 * control plane's next re-push waits out its paced window). A crash
 * mid-generation leaves stale bytes and NO ack — `applied` stays behind and
 * the next boot's full sync erases them; prune riding only the final part is
 * what makes a partial apply unable to delete anything prematurely.
 *
 * Managed roots are exactly the adapter's skillsDir and `memory/` — nothing
 * else is writable or prunable through this channel by construction; a path
 * outside them is refused with a warning (the wire schema already made
 * traversal unrepresentable — this is the braces).
 *
 * `memory/` is special since the write-back amendment (§3.8, 2026-08-10):
 * its files are AGENT-WRITABLE (0644; `index.md` stays generated at 0444),
 * and agent-authored bytes are never destroyed by this channel — a file
 * whose checksum does not verify is handed to the harvester and left in
 * place; the platform save it produces bumps a new generation whose
 * canonical render supersedes it. Only checksum-verified (unmodified)
 * projections are overwritten or pruned.
 */

/** The wire's canonical skills prefix; re-rooted onto the adapter's declared
 * skillsDir when they differ, so the wire stays vendor-neutral. */
const CANONICAL_SKILLS_ROOT = ".agents/skills";
const MEMORY_ROOT = "memory";
const MEMORY_INDEX_PATH = `${MEMORY_ROOT}/index.md`;

const PROJECTION_MODE = 0o444;
/** Memory files are the agent's working copy — writable by design. */
const MEMORY_FILE_MODE = 0o644;

type SyncItem = Extract<WorkItem, { kind: "skills.changed" }>;

/** Map a canonical wire path onto this home's real relative path, or
 * null when it belongs to no managed root (refused) or the adapter declares
 * no skills directory (skill files are skipped whole). */
const mapManagedPath = (
  path: string,
  skillsDir: string | null,
): string | null => {
  if (path === MEMORY_ROOT || path.startsWith(`${MEMORY_ROOT}/`)) return path;
  if (
    path === CANONICAL_SKILLS_ROOT ||
    path.startsWith(`${CANONICAL_SKILLS_ROOT}/`)
  ) {
    if (!skillsDir) return null;
    return skillsDir === CANONICAL_SKILLS_ROOT
      ? path
      : `${skillsDir}${path.slice(CANONICAL_SKILLS_ROOT.length)}`;
  }
  return null;
};

const isMemoryFilePath = (mapped: string): boolean =>
  mapped.startsWith(`${MEMORY_ROOT}/`) && mapped !== MEMORY_INDEX_PATH;

/** lstat-hardened read of a managed target: content when it is a regular
 * non-link file we may compare against, null otherwise. */
const readRegular = (target: string): string | null => {
  try {
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
    if (stat.size > MAX_HARVEST_FILE_BYTES) return null;
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
};

/**
 * Prune the memory root — the harvest-aware replacement for
 * `pruneManagedRoot` (which deletes ANYTHING outside the manifest and would
 * destroy every agent-authored file the harvester spared). The laws:
 *
 *  - symlinks are unlinked as links (never followed) — they are never
 *    projections and never harvestable;
 *  - `index.md` is fully managed: the manifest alone decides it;
 *  - a checksum-verified file outside the manifest is a PLATFORM DELETE
 *    landing — remove it (this is what lets "delete in the dashboard while
 *    the sandbox is parked" actually stick at the next boot);
 *  - anything else under memory/ is agent-authored bytes: harvest first when
 *    the name can be a key, and KEEP the file regardless of outcome — an
 *    uploaded file re-enters the very next manifest, a refused one is data
 *    this channel never destroys (steered by the fragment);
 *  - directories are left alone (never projected, possibly agent data).
 *
 * BOUNDED like the harvester's own scan: the readdir is sliced at
 * MAX_HARVEST_SCAN_ENTRIES and harvest round-trips are capped per pass —
 * a hostile agent writing thousands of validly-keyed divergent files must
 * not turn one final-part prune into thousands of serial RPCs while every
 * turn waits behind the sync chain. The overflow is left for the next
 * generation's paced re-push (files are never lost by being deferred).
 */
const pruneMemoryRoot = async (
  homeDir: string,
  keep: ReadonlySet<string>,
  harvester: MemoryHarvester | null,
): Promise<void> => {
  const rootAbs = ensureManagedDir(homeDir, MEMORY_ROOT);
  let harvestsThisPass = 0;
  let keptUnmanaged = 0;
  // Same tolerance the skills prune has: an agent's nested container can leave
  // a subuid-owned memory/ that this uid cannot read. Skip-and-warn rather
  // than throw (which would poison every future generation); a real IO fault
  // still propagates.
  let rootEntries;
  try {
    rootEntries = readdirSync(rootAbs, { withFileTypes: true });
  } catch (err) {
    if (!isToleratedPruneError(err)) throw err;
    log("warn", "memory root unreadable; prune skipped this pass", {
      code: (err as NodeJS.ErrnoException).code,
    });
    return;
  }
  for (const entry of rootEntries.slice(0, MAX_HARVEST_SCAN_ENTRIES)) {
    const rel = `${MEMORY_ROOT}/${entry.name}`;
    const abs = join(rootAbs, entry.name);
    if (entry.isSymbolicLink()) {
      rmSync(abs, { force: true });
      continue;
    }
    if (entry.isDirectory()) continue;
    if (keep.has(rel)) continue;
    if (rel === MEMORY_INDEX_PATH) {
      rmSync(abs, { force: true });
      continue;
    }
    const content = readRegular(abs);
    if (content !== null && isUnmodifiedProjection(content)) {
      rmSync(abs, { force: true });
      // The projection is gone; its ledger entry must go too, or a later
      // byte-identical re-creation would be swallowed as "already uploaded".
      harvester?.forgetFile(entry.name);
      continue;
    }
    if (harvester && memoryKeyOfFileName(entry.name)) {
      // The RPC ceiling: past it, leave the file for the next generation
      // rather than block turn delivery on an unbounded serial sweep.
      if (harvestsThisPass >= MAX_HARVEST_SCAN_ENTRIES) continue;
      harvestsThisPass += 1;
      const outcome = await harvester.harvestFile(entry.name);
      if (outcome === "pristine" || outcome === "uploaded") {
        // The platform HOLDS these bytes — the file may go. A fresh upload's
        // own bump re-projects the canonical render in the next generation;
        // a ledger hit on a manifest-absent key is a landed DELETE (the raw
        // file outlived its render across a crash — found live: without
        // this, it resurrected a memory a human had deleted while the box
        // was down). refused/retry stay: bytes the platform does NOT hold
        // are never destroyed.
        rmSync(abs, { force: true });
        // Consume the ledger entry: after the delete, a re-created
        // byte-identical file must upload afresh, not skip on a stale hash.
        harvester.forgetFile(entry.name);
      }
      continue;
    }
    keptUnmanaged += 1;
  }
  // One summary line per pass, not one per file — a directory of scratch
  // drafts must not spew a log line each on every generation.
  if (keptUnmanaged > 0) {
    log("warn", "unmanaged files under memory/ kept (agent data)", {
      count: keptUnmanaged,
    });
  }
};

export const applyHomeSync = async (
  homeDir: string,
  item: SyncItem,
  renderInputs: RenderInputs,
  send: (message: SupervisorMessage) => void,
  harvester: MemoryHarvester | null = null,
): Promise<void> => {
  const skillsDir = renderInputs.capabilities.skillsDir;

  for (const file of item.files) {
    const mapped = mapManagedPath(file.path, skillsDir);
    if (mapped === null) {
      const isSkillPath = file.path.startsWith(`${CANONICAL_SKILLS_ROOT}/`);
      if (isSkillPath && !skillsDir) {
        // This adapter loads no skills — skipped quietly by design.
      } else {
        log("warn", "sync file outside the managed roots; refused", {
          path: file.path,
        });
      }
      continue;
    }
    const target = join(homeDir, mapped);
    ensureManagedDir(homeDir, dirname(mapped));
    const isMemoryFile = isMemoryFilePath(mapped);
    const mode = isMemoryFile ? MEMORY_FILE_MODE : PROJECTION_MODE;
    // Idempotent: a byte-identical REGULAR file is left untouched, so its
    // mtime is honest evidence of when content last CHANGED (the live proof
    // reads it), and repeated re-pushes cost nothing. lstat first: a planted
    // symlink must never survive by pointing at byte-identical content —
    // anything that is not a regular file is replaced regardless.
    let existing: string | null = null;
    let existingMode: number | null = null;
    try {
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (stat?.isFile() && !stat.isSymbolicLink()) {
        existing = readFileSync(target, "utf8");
        existingMode = stat.mode & 0o777;
      }
    } catch {
      existing = null;
    }
    if (existing === file.content) {
      // Same bytes, possibly stale mode (files written before the write-back
      // amendment landed 0444): reconcile via the symlink-safe rewrite, never
      // a chmod that could be re-aimed at another target.
      if (existingMode !== null && existingMode !== mode) {
        writeManagedFile(target, file.content, mode);
      }
      continue;
    }
    if (
      isMemoryFile &&
      existing !== null &&
      !isUnmodifiedProjection(existing)
    ) {
      // Agent-authored bytes where the projection wants to land: harvest
      // FIRST, and let the outcome decide. "uploaded"/"pristine" mean the
      // platform holds these bytes, so the canonical render may land — it
      // either already contains them, or the save's own bump delivers the
      // one that does next. A refusal/timeout means bytes the platform does
      // NOT hold: leave the file, skip this path (warned by the harvester;
      // never destroyed) — the generation still applies and acks.
      const fileName = mapped.slice(MEMORY_ROOT.length + 1);
      const outcome = harvester
        ? await harvester.harvestFile(fileName)
        : "refused";
      if (!harvester) {
        log("warn", "agent-authored memory file left un-harvested", {
          path: mapped,
        });
      }
      if (outcome !== "uploaded" && outcome !== "pristine") continue;
    }
    writeManagedFile(target, file.content, mode);
  }

  const isFinal = item.part === item.of;
  if (!isFinal) return;

  // Prune each managed root to the manifest (mapped onto this home's
  // real paths). An empty manifest prunes the root clean — exactly right
  // for an agent whose last skill or memory was deleted.
  const manifest = item.prune ?? [];
  if (skillsDir) {
    const keepSkills = new Set(
      manifest
        .map((path) => mapManagedPath(path, skillsDir))
        .filter(
          (mapped): mapped is string =>
            mapped !== null && mapped.startsWith(`${skillsDir}/`),
        ),
    );
    const inaccessible = pruneManagedRoot(homeDir, skillsDir, keepSkills);
    // One summary line per pass (the memory prune's posture): subuid-owned
    // leftovers from a nested-container volume mount are skipped, not fatal.
    if (inaccessible > 0) {
      log("warn", "inaccessible entries under the skills root skipped", {
        count: inaccessible,
      });
    }
  }
  const keepMemory = new Set(
    manifest.filter((path) => path.startsWith(`${MEMORY_ROOT}/`)),
  );
  await pruneMemoryRoot(homeDir, keepMemory, harvester);

  // Fresh render inputs ride the final part (empty string = cleared). The
  // instruction docs re-render on EVERY final part — idempotent, and the
  // same self-heal the boot render provides.
  if (item.instructions !== undefined) {
    renderInputs.instructions =
      item.instructions === "" ? undefined : item.instructions;
  }
  if (item.agentName !== undefined) {
    renderInputs.agentName = item.agentName === "" ? undefined : item.agentName;
  }
  renderHome(homeDir, renderInputs);

  // ALWAYS ack — even a no-op repeat: the previous ack may be exactly what
  // was dropped. The control plane's lt-guarded update makes duplicates
  // inert.
  send({ kind: "home.synced", generation: item.generation });
};
