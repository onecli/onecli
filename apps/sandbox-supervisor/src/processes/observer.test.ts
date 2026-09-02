import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  HarnessBackgroundTask,
  SupervisorMessage,
} from "@onecli/agent-protocol";
import { createProcessManager, MAX_OBSERVED_TASKS } from "./manager";
import { createProcessObserver, IMPLICIT_WAKE_PROMPT } from "./observer";

/**
 * The observer against a REAL manager — the mirror, the implicit wake watch,
 * and every dedup/teardown guard. The provider is scripted (the jcode format
 * has its own suite); what is proven here is the translation of native-task
 * lifecycles into the exact machinery the platform tools use.
 */

type ProcessFrame = Extract<SupervisorMessage, { kind: "process.state" }>;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

const rig = (opts?: {
  activeTurn?: () => { conversationId: string; turnId: string } | null;
  resendEveryTicks?: number;
}) => {
  const sent: ProcessFrame[] = [];
  const manager = createProcessManager({
    homeDir: mkdtempSync(join(tmpdir(), "obs-ws-")),
    send: (m) => {
      if (m.kind === "process.state") sent.push(m);
    },
    sweepIntervalMs: 20,
    resendEveryTicks: opts?.resendEveryTicks ?? 5,
  });
  const snapshots: HarnessBackgroundTask[] = [];
  let polls = 0;
  const observer = createProcessObserver({
    manager,
    tasks: {
      poll: async () => {
        polls += 1;
        return [...snapshots];
      },
    },
    activeTurn: opts?.activeTurn ?? (() => null),
    intervalMs: 3_600_000, // timer inert — tests drive poll() directly
  });
  cleanups.push(() => {
    observer.stop();
    manager.close();
  });
  return {
    manager,
    observer,
    sent,
    snapshots,
    pollCount: () => polls,
  };
};

const task = (
  over: Partial<HarnessBackgroundTask> = {},
): HarnessBackgroundTask => ({
  ref: "task-1",
  command: "sleep 20;",
  status: "running",
  startedAt: new Date().toISOString(),
  wantsWake: false,
  ...over,
});

const latest = (sent: ProcessFrame[], ref: string) =>
  [...sent].reverse().find((f) => f.process.ref === ref)?.process;

describe("mirroring", () => {
  it("a running native task becomes a running entry and frames immediately", async () => {
    const { observer, sent, snapshots } = rig();
    snapshots.push(task());
    await observer.poll();
    expect(latest(sent, "task-1")).toMatchObject({
      ref: "task-1",
      command: "sleep 20;",
      status: "running",
    });
  });

  it("a terminal snapshot lands through finalize with the exit code", async () => {
    const { observer, sent, snapshots } = rig();
    snapshots.push(task());
    await observer.poll();
    snapshots[0] = task({ status: "exited", exitCode: 3 });
    await observer.poll();
    expect(latest(sent, "task-1")).toMatchObject({
      status: "exited",
      exitCode: 3,
    });
  });

  it("a task first seen ALREADY terminal still mirrors (its running frames were never observed)", async () => {
    const { observer, sent, snapshots } = rig();
    snapshots.push(task({ status: "exited", exitCode: 0 }));
    await observer.poll();
    expect(latest(sent, "task-1")).toMatchObject({
      status: "exited",
      exitCode: 0,
    });
  });

  it("an output delta feeds an agent-armed pattern watch", async () => {
    const { manager, observer, sent, snapshots } = rig();
    snapshots.push(task());
    await observer.poll();
    manager.watch(
      { processId: "task-1", kind: "pattern", pattern: "READY", prompt: "go" },
      null,
    );
    snapshots[0] = task({ outputDelta: "almost REA" });
    await observer.poll();
    snapshots[0] = task({ outputDelta: "DY now" }); // split across polls
    await observer.poll();
    const watch = latest(sent, "task-1")?.watches[0];
    expect(watch).toMatchObject({ status: "triggered", trigger: "matched" });
  });

  it("terminal-seen: an evicted terminal ref is never re-created from its lingering snapshot", async () => {
    // Re-sends quieted: churn is visible only as CHANGE frames.
    const { manager, observer, sent, snapshots } = rig({
      resendEveryTicks: 100_000,
    });
    // 21 terminal tasks: the manager retains 20, evicting the oldest — whose
    // status file (snapshot) still exists. MUTATION-PROOF: drop the
    // terminal-seen set and the next poll re-creates the evicted entry (the
    // count stays 20 either way — churn shows up as frames, so THAT is the
    // assertion).
    for (let i = 0; i < MAX_OBSERVED_TASKS + 1; i += 1) {
      snapshots.push(task({ ref: `t-${i}`, status: "exited", exitCode: 0 }));
    }
    await observer.poll();
    expect((manager.status({}).result as unknown[]).length).toBe(
      MAX_OBSERVED_TASKS, // one evicted
    );
    const frames = sent.length;
    await observer.poll(); // snapshots unchanged — nothing may reappear
    expect(sent.length).toBe(frames);
    expect((manager.status({}).result as unknown[]).length).toBe(
      MAX_OBSERVED_TASKS,
    );
  });

  it("caps observed RUNNING mirrors and reports over-cap instead of tracking", async () => {
    const { manager, observer, snapshots } = rig();
    for (let i = 0; i < MAX_OBSERVED_TASKS + 1; i += 1) {
      snapshots.push(task({ ref: `r-${i}` }));
    }
    await observer.poll();
    expect((manager.status({}).result as unknown[]).length).toBe(
      MAX_OBSERVED_TASKS,
    );
  });
});

describe("the implicit wake watch", () => {
  it("wake intent arms ONE exit watch with the platform prompt — never a duplicate", async () => {
    const { observer, sent, snapshots } = rig();
    snapshots.push(task({ wantsWake: true }));
    await observer.poll();
    await observer.poll(); // MUTATION-PROOF: drop arm-once and this doubles
    const watches = latest(sent, "task-1")?.watches ?? [];
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({ kind: "exit", status: "armed" });
    expect(watches[0]?.prompt).toBe(IMPLICIT_WAKE_PROMPT);
  });

  it("ANY armed watch suppresses the implicit one (a wake is already guaranteed)", async () => {
    const { manager, observer, sent, snapshots } = rig();
    snapshots.push(task());
    await observer.poll();
    // The agent armed its own pattern watch — exit fires it anyway (finalize
    // fires ALL armed watches), so an implicit exit watch would double-report.
    manager.watch(
      { processId: "task-1", kind: "pattern", pattern: "X", prompt: "mine" },
      null,
    );
    snapshots[0] = task({ wantsWake: true });
    await observer.poll();
    const watches = latest(sent, "task-1")?.watches ?? [];
    expect(watches).toHaveLength(1);
    expect(watches[0]?.prompt).toBe("mine");
  });

  it("a revoked wake cancels the implicit watch (the harness honors the FINAL flag)", async () => {
    const { observer, sent, snapshots } = rig();
    snapshots.push(task({ wantsWake: true }));
    await observer.poll();
    snapshots[0] = task({ wantsWake: false });
    await observer.poll();
    const watch = latest(sent, "task-1")?.watches[0];
    expect(watch?.status).toBe("canceled");
  });

  it("wake intent on a task first seen terminal fires immediately (arm-on-terminal)", async () => {
    const { observer, sent, snapshots } = rig();
    snapshots.push(task({ status: "exited", exitCode: 0, wantsWake: true }));
    await observer.poll();
    const watch = latest(sent, "task-1")?.watches[0];
    expect(watch).toMatchObject({
      kind: "exit",
      status: "triggered",
      trigger: "exited",
    });
  });

  it("anchors the implicit watch to the active turn at arm time", async () => {
    const { observer, sent, snapshots } = rig({
      activeTurn: () => ({ conversationId: "conv-1", turnId: "turn-1" }),
    });
    snapshots.push(task({ wantsWake: true }));
    await observer.poll();
    expect(latest(sent, "task-1")?.watches[0]).toMatchObject({
      conversationId: "conv-1",
      turnId: "turn-1",
    });
  });

  it("a snapshot's OWN context beats the active-turn heuristic — a sibling's turn cannot steal the anchor", async () => {
    const { observer, sent, snapshots } = rig({
      // The wrong chat: some OTHER conversation's turn is running.
      activeTurn: () => ({ conversationId: "conv-sibling", turnId: "turn-x" }),
    });
    snapshots.push(
      task({
        status: "exited",
        wantsWake: true,
        context: { conversationId: "conv-owner" },
      }),
    );
    await observer.poll();
    const proc = latest(sent, "task-1");
    expect(proc?.conversationId).toBe("conv-owner");
    expect(proc?.watches[0]).toMatchObject({ conversationId: "conv-owner" });
    // Conversation-only anchor: no turn id is invented.
    expect(proc?.watches[0]?.turnId).toBeUndefined();
  });

  it("a snapshot's wakePrompt replaces the generic implicit prompt", async () => {
    const { observer, sent, snapshots } = rig();
    snapshots.push(
      task({
        status: "exited",
        wantsWake: true,
        wakePrompt: "Helpers finished — collect and deliver the ranking.",
      }),
    );
    await observer.poll();
    expect(latest(sent, "task-1")?.watches[0]?.prompt).toBe(
      "Helpers finished — collect and deliver the ranking.",
    );
  });

  it("a born-terminal snapshot's output rides the excerpt into the triggered watch", async () => {
    const { observer, sent, snapshots } = rig();
    snapshots.push(
      task({
        status: "exited",
        wantsWake: true,
        outputDelta: "🐝 all members done: alpha, beta",
      }),
    );
    await observer.poll();
    const watch = latest(sent, "task-1")?.watches[0];
    expect(watch?.status).toBe("triggered");
    expect(watch?.excerpt).toContain("all members done");
  });
});

describe("boundaries with the owned world", () => {
  it("observed running tasks never consume the process_start cap", async () => {
    const { manager, observer, snapshots } = rig();
    for (let i = 0; i < 6; i += 1) snapshots.push(task({ ref: `n-${i}` }));
    await observer.poll();
    // MUTATION-PROOF: count observed entries in the start cap and this refuses.
    const started = manager.start({ command: "sleep 0.2" }, null);
    expect(started.ok).toBe(true);
  });

  it("process_stop refuses an observed task readably", async () => {
    const { manager, observer, snapshots } = rig();
    snapshots.push(task());
    await observer.poll();
    const stopped = manager.stop({ processId: "task-1" });
    expect(stopped.ok).toBe(false);
    expect(String(stopped.error)).toContain("your own tooling");
  });

  it("observed entries ride the periodic re-send (the reliability law)", async () => {
    const { observer, sent, snapshots } = rig();
    snapshots.push(task());
    await observer.poll();
    const before = sent.filter((f) => f.process.ref === "task-1").length;
    // resendEveryTicks=5 at 20ms sweeps → a re-send lands within ~200ms.
    await expect
      .poll(
        () => sent.filter((f) => f.process.ref === "task-1").length > before,
        { timeout: 2_000 },
      )
      .toBe(true);
  });

  it("stop() freezes observation — no further provider polls act", async () => {
    const { observer, snapshots, sent } = rig();
    snapshots.push(task());
    await observer.poll();
    observer.stop();
    snapshots.push(task({ ref: "late" }));
    await observer.poll();
    expect(latest(sent, "late")).toBeUndefined();
  });
});
