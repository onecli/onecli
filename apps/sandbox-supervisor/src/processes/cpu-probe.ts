import { readdir, readFile } from "node:fs/promises";

/**
 * The CPU half of the busy signal (keep-awake's engagement predicate).
 *
 * A background process that prints nothing can still be working — a long
 * compile, a silent crawler — and output recency alone would park it. The
 * other way round, a web server nobody visits prints nothing AND burns
 * nothing, and that is exactly the box that must park. CPU time is the
 * signal that separates the two, read from the guest kernel's own
 * accounting:
 *
 * - per process, `/proc/<pid>/stat` fields 14+15 (utime+stime, in clock
 *   ticks) summed over the process GROUP the manager spawned (the shell and
 *   whatever it ran — a `make` is its children, not the leader);
 * - sandbox-wide, `/proc/stat`'s first line (every CPU's user+nice+system),
 *   the fallback for tasks the supervisor has no pid for (a harness's own
 *   background tasks are observed, not spawned).
 *
 * Pure parsers (unit-tested on fixtures) plus one sampler that keeps the
 * last reading and answers "busy since the previous sample?" — a rate
 * question, so two samples are needed before it can ever say yes. Every
 * read failure is "not busy": the fail-safe direction is to park.
 */

/** Clock ticks per second on every Linux the agent image runs on. */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Busy = more than this fraction of ONE core's time between two samples.
 * 2% is far above the noise of a quiet server (a health-check tick, a
 * keepalive) and far below any real work (a compile is 100%+).
 */
export const CPU_BUSY_FRACTION = 0.02;

/**
 * The fields of one `/proc/<pid>/stat` line this module reads. The comm
 * field is parenthesised and may itself contain spaces and parens, so the
 * fields are counted from the LAST ')' — the kernel's own documented rule:
 * after "<pid> (<comm>)" the rest starts at field 3 (state), so pgrp is
 * field 5 → index 2, utime 14 → 11, stime 15 → 12.
 */
export const parseProcPidStat = (
  line: string,
): { pgrp: number; ticks: number } | null => {
  const end = line.lastIndexOf(")");
  if (end < 0) return null;
  const rest = line
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const pgrp = Number(rest[2]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (![pgrp, utime, stime].every(Number.isFinite)) return null;
  return { pgrp, ticks: utime + stime };
};

/** user+nice+system (ticks, all CPUs) from `/proc/stat`'s `cpu` line. */
export const parseProcStat = (table: string): number | null => {
  const line = table.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const [, user, nice, system] = line.trim().split(/\s+/);
  const ticks = Number(user) + Number(nice) + Number(system);
  return Number.isFinite(ticks) ? ticks : null;
};

export interface CpuProbeOptions {
  /** Test seams; production reads the real /proc. */
  readFile?: (path: string) => Promise<string>;
  readDir?: (path: string) => Promise<string[]>;
  now?: () => number;
}

export interface CpuProbe {
  /**
   * Whether the process group led by `pgid` used more than the busy fraction
   * of one core since the last call for that pgid. The first call for a
   * group only records a baseline and answers false.
   */
  groupBusy(pgid: number): Promise<boolean>;
  /** The same question for the whole sandbox (every process in the guest). */
  sandboxBusy(): Promise<boolean>;
  /** Drop a group's baseline once its process ended. */
  forget(pgid: number): void;
}

interface Sample {
  ticks: number;
  atMs: number;
}

export const createCpuProbe = (options: CpuProbeOptions = {}): CpuProbe => {
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const readDir = options.readDir ?? ((path: string) => readdir(path));
  const now = options.now ?? (() => Date.now());

  const groups = new Map<number, Sample>();
  let sandbox: Sample | null = null;

  /** Busy iff the tick delta over the elapsed wall time exceeds the fraction
   * of one core. Returns the new baseline alongside. */
  const judge = (
    previous: Sample | null,
    ticks: number,
  ): [busy: boolean, sample: Sample] => {
    const atMs = now();
    const next = { ticks, atMs };
    if (!previous) return [false, next];
    const elapsedTicks =
      ((atMs - previous.atMs) / 1000) * CLOCK_TICKS_PER_SECOND;
    if (elapsedTicks <= 0) return [false, previous];
    return [(ticks - previous.ticks) / elapsedTicks > CPU_BUSY_FRACTION, next];
  };

  /** Summed ticks of every process in group `pgid`: one readdir plus one
   * small read per live pid (the sampler runs once a second for at most a
   * handful of groups). A pid that exits mid-walk is simply not in the
   * group any more. */
  const groupTicks = async (pgid: number): Promise<number> => {
    let ticks = 0;
    for (const name of await readDir("/proc")) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const parsed = await read(`/proc/${pid}/stat`)
        .then(parseProcPidStat)
        .catch(() => null);
      if (parsed?.pgrp === pgid) ticks += parsed.ticks;
    }
    return ticks;
  };

  return {
    async groupBusy(pgid) {
      try {
        const [busy, sample] = judge(
          groups.get(pgid) ?? null,
          await groupTicks(pgid),
        );
        groups.set(pgid, sample);
        return busy;
      } catch {
        return false;
      }
    },
    async sandboxBusy() {
      try {
        const ticks = parseProcStat(await read("/proc/stat"));
        if (ticks === null) return false;
        const [busy, sample] = judge(sandbox, ticks);
        sandbox = sample;
        return busy;
      } catch {
        return false;
      }
    },
    forget(pgid) {
      groups.delete(pgid);
    },
  };
};
