import { describe, expect, it } from "vitest";
import {
  CPU_BUSY_FRACTION,
  createCpuProbe,
  parseProcPidStat,
  parseProcStat,
} from "./cpu-probe";

/**
 * The CPU half of the busy signal on fixtures: the /proc parsers against the
 * kernel's own documented layout (including the comm-with-spaces trap), and
 * the sampler's rate arithmetic with a fake clock and a fake /proc.
 */

describe("parseProcPidStat", () => {
  it("reads pgrp, utime and stime by counting from the last ')'", () => {
    // pid 42, comm "node", state S, ppid 1, pgrp 42, session 42, tty 0,
    // tpgid -1, flags, minflt, cminflt, majflt, cmajflt, utime 150, stime 50.
    const line =
      "42 (node) S 1 42 42 0 -1 4194560 1234 0 0 0 150 50 0 0 20 0 1 0 100 0 0";
    expect(parseProcPidStat(line)).toEqual({ pgrp: 42, ticks: 200 });
  });

  it("is not fooled by a comm that contains spaces and parens", () => {
    const line =
      "7 (my (odd) prog) R 1 7 7 0 -1 0 0 0 0 0 3 4 0 0 20 0 1 0 100 0 0";
    expect(parseProcPidStat(line)).toEqual({ pgrp: 7, ticks: 7 });
  });

  it("rejects a line with no comm or too few fields", () => {
    expect(parseProcPidStat("garbage")).toBeNull();
    expect(parseProcPidStat("1 (x) S 1")).toBeNull();
  });
});

describe("parseProcStat", () => {
  it("sums user+nice+system of the aggregate cpu line", () => {
    const table = [
      "cpu  1000 20 300 50000 10 0 5 0 0 0",
      "cpu0 500 10 150 25000 5 0 2 0 0 0",
      "intr 12345",
    ].join("\n");
    expect(parseProcStat(table)).toBe(1320);
  });

  it("returns null without the aggregate line", () => {
    expect(parseProcStat("cpu0 1 2 3 4\n")).toBeNull();
  });
});

describe("createCpuProbe", () => {
  /** A fake /proc: pids with their (pgrp, ticks), and a global cpu line. */
  const fakeProc = (
    pids: Record<number, { pgrp: number; ticks: number }>,
    cpuTicks: number,
  ) => ({
    readDir: async () => [...Object.keys(pids), "self", "stat"],
    readFile: async (path: string) => {
      if (path === "/proc/stat") return `cpu  ${cpuTicks} 0 0 1000 0 0 0`;
      const pid = Number(path.split("/")[2]);
      const entry = pids[pid];
      if (!entry) throw new Error("ENOENT");
      return `${pid} (p) S 1 ${entry.pgrp} 1 0 -1 0 0 0 0 0 ${entry.ticks} 0 0 0 20 0 1 0 1 0 0`;
    },
  });

  it("answers false on the first sample (a rate needs two readings)", async () => {
    let t = 0;
    const probe = createCpuProbe({
      ...fakeProc({ 10: { pgrp: 10, ticks: 500 } }, 9000),
      now: () => t,
    });
    expect(await probe.groupBusy(10)).toBe(false);
    expect(await probe.sandboxBusy()).toBe(false);
    t += 1000;
  });

  it("sums the whole process group and reports busy above the fraction, idle below it", async () => {
    let t = 0;
    const pids = {
      10: { pgrp: 10, ticks: 0 },
      11: { pgrp: 10, ticks: 0 }, // a child of the group leader
      99: { pgrp: 99, ticks: 0 }, // another group: never counted
    };
    const probe = createCpuProbe({ ...fakeProc(pids, 0), now: () => t });
    await probe.groupBusy(10);

    // One second later the group used 10 ticks across two pids: 10% of a
    // core, well over the 2% line. The other group's burn is irrelevant.
    t += 1000;
    pids[10].ticks = 4;
    pids[11].ticks = 6;
    pids[99].ticks = 500;
    expect(await probe.groupBusy(10)).toBe(true);

    // The next second: 1 tick = 1% < CPU_BUSY_FRACTION (2%): idle.
    t += 1000;
    pids[11].ticks = 7;
    expect(await probe.groupBusy(10)).toBe(false);
    expect(CPU_BUSY_FRACTION).toBe(0.02);
  });

  it("the sandbox-wide probe reads /proc/stat with the same rule", async () => {
    let t = 0;
    let cpu = 1000;
    const probe = createCpuProbe({
      ...fakeProc({}, 0),
      readFile: async () => `cpu  ${cpu} 0 0 1 0 0 0`,
      now: () => t,
    });
    await probe.sandboxBusy();
    t += 1000;
    cpu += 50; // 50% of a core
    expect(await probe.sandboxBusy()).toBe(true);
    t += 1000;
    cpu += 1; // 1%
    expect(await probe.sandboxBusy()).toBe(false);
  });

  it("a read failure is 'not busy' (the fail-safe direction), and forget drops the baseline", async () => {
    let t = 0;
    const pids = { 10: { pgrp: 10, ticks: 0 } };
    const probe = createCpuProbe({
      readDir: async () => {
        throw new Error("EACCES");
      },
      readFile: fakeProc(pids, 0).readFile,
      now: () => t,
    });
    expect(await probe.groupBusy(10)).toBe(false);
    t += 1000;
    expect(await probe.groupBusy(10)).toBe(false);

    const healthy = createCpuProbe({ ...fakeProc(pids, 0), now: () => t });
    await healthy.groupBusy(10);
    t += 1000;
    pids[10].ticks = 50;
    healthy.forget(10);
    // After forget the next call is a fresh baseline: false, not the 50%
    // the stale baseline would have shown.
    expect(await healthy.groupBusy(10)).toBe(false);
  });

  it("a zero or negative clock step never divides by zero", async () => {
    const probe = createCpuProbe({
      ...fakeProc({ 10: { pgrp: 10, ticks: 0 } }, 0),
      now: () => 5000,
    });
    await probe.groupBusy(10);
    expect(await probe.groupBusy(10)).toBe(false);
  });
});
