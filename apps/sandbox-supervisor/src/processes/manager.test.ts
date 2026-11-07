import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupervisorMessage } from "@onecli/agent-protocol";
import {
  createProcessManager,
  MAX_PROCESSES_PER_SANDBOX,
  MAX_WATCHES_PER_PROCESS,
  TURN_END_SAFETY_NET_PROMPT,
  type ProcessManager,
} from "./manager";
import type { CpuProbe } from "./cpu-probe";

/**
 * The process manager against REAL children (the platform-tools.test.ts
 * posture — the physics are the point, so we spawn actual `/bin/sh`). Each
 * rig gets a fresh home and a fast sweeper so silence/expiry are quick.
 */

type ProcessFrame = Extract<SupervisorMessage, { kind: "process.state" }>;

let managers: ProcessManager[] = [];
afterEach(() => {
  for (const m of managers) m.close();
  managers = [];
});

/** A CPU probe with scripted verdicts: the manager's seam, so the busy
 * signal is proven without a real /proc walk (cpu-probe.test.ts has those). */
const scriptedProbe = (verdict: {
  group?: (pgid: number) => boolean;
  sandbox?: () => boolean;
}): CpuProbe & { forgotten: number[] } => {
  const forgotten: number[] = [];
  return {
    forgotten,
    groupBusy: async (pgid) => verdict.group?.(pgid) ?? false,
    sandboxBusy: async () => verdict.sandbox?.() ?? false,
    forget: (pgid) => {
      forgotten.push(pgid);
    },
  };
};

const rig = (opts?: {
  sweepIntervalMs?: number;
  stopGraceMs?: number;
  now?: () => number;
  cpuProbe?: CpuProbe;
}) => {
  const sent: ProcessFrame[] = [];
  const manager = createProcessManager({
    homeDir: mkdtempSync(join(tmpdir(), "pm-ws-")),
    send: (m) => {
      if (m.kind === "process.state") sent.push(m);
    },
    sweepIntervalMs: opts?.sweepIntervalMs ?? 20,
    resendEveryTicks: 5,
    stopGraceMs: opts?.stopGraceMs ?? 300,
    // Quiet by default: the real probe would read this host's /proc.
    cpuProbe: opts?.cpuProbe ?? scriptedProbe({}),
    ...(opts?.now && { now: opts.now }),
  });
  managers.push(manager);
  return { manager, sent };
};

const latest = (sent: ProcessFrame[], ref: string): ProcessFrame["process"] =>
  [...sent].reverse().find((f) => f.process.ref === ref)!.process;

/** Poll a predicate against the newest frame for a ref. */
const waitFor = async (
  sent: ProcessFrame[],
  ref: string,
  pred: (p: ProcessFrame["process"]) => boolean,
): Promise<ProcessFrame["process"]> => {
  await expect
    .poll(
      () => {
        const f = [...sent].reverse().find((x) => x.process.ref === ref);
        return f ? pred(f.process) : false;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  return latest(sent, ref);
};

const startId = (r: { ok: boolean; result?: unknown }): string =>
  (r.result as { processId: string }).processId;

describe("spawn + tail", () => {
  it("captures interleaved stdout+stderr and frames it immediately", async () => {
    const { manager, sent } = rig();
    const id = startId(
      manager.start({ command: "echo out; echo err 1>&2" }, null),
    );
    expect(sent.at(-1)?.process.status).toBe("running"); // sent on spawn
    const p = await waitFor(sent, id, (x) => x.status === "exited");
    expect(p.exitCode).toBe(0);
    expect(p.tail).toContain("out");
    expect(p.tail).toContain("err");
  });

  it("children inherit the supervisor env — zero-cred by inheritance (gateway proxy + CA)", async () => {
    // The gateway proxy + CA vars live in the supervisor's env; a child that
    // did NOT inherit them would egress uncredentialed and unproxied (an open
    // relay). MUTATION-PROOF: change spawn's `env: process.env` to `env: {}`
    // (or strip the vars) and the child sees nothing here.
    const SENTINEL = "onecli-egress-sentinel-8b3f";
    // stubEnv (not a raw process.env assignment) mutates the live env the
    // child inherits, and dodges the turbo undeclared-env-var lint for a
    // test-only sentinel.
    vi.stubEnv("ONECLI_TEST_EGRESS_SENTINEL", SENTINEL);
    try {
      const { manager, sent } = rig();
      const id = startId(
        manager.start(
          { command: 'printf "SEEN=%s" "$ONECLI_TEST_EGRESS_SENTINEL"' },
          null,
        ),
      );
      const p = await waitFor(sent, id, (x) => x.status === "exited");
      expect(p.tail ?? "").toContain(`SEEN=${SENTINEL}`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("strips NUL bytes from binary output before the tail (§8)", async () => {
    const { manager, sent } = rig();
    const id = startId(manager.start({ command: "printf 'A\\000B'" }, null));
    const p = await waitFor(sent, id, (x) => x.status === "exited");
    // MUTATION-PROOF: drop stripNul in onOutput and the NUL splits "AB" (and
    // would then break the control plane's Postgres text insert).
    expect(p.tail).toContain("AB");
    expect(p.tail ?? "").not.toContain(String.fromCharCode(0));
  });
});

describe("exit detection", () => {
  it("records a non-zero exit code", async () => {
    const { manager, sent } = rig();
    const id = startId(manager.start({ command: "exit 3" }, null));
    const p = await waitFor(sent, id, (x) => x.status === "exited");
    expect(p.exitCode).toBe(3);
  });

  it("distinguishes a stopped process from a natural exit", async () => {
    const { manager, sent } = rig({ stopGraceMs: 200 });
    const id = startId(manager.start({ command: "sleep 30" }, null));
    await waitFor(sent, id, (x) => x.status === "running");
    manager.stop({ processId: id });
    const p = await waitFor(sent, id, (x) => x.status !== "running");
    expect(p.status).toBe("stopped");
  });
});

describe("group kill", () => {
  it("SIGTERMs the whole process GROUP — the shell's backgrounded child dies too", async () => {
    // The shell backgrounds a `sleep` and records its pid, then waits. The
    // shell itself dies under EITHER kill(pid) or kill(-pid), so observing
    // only the shell proves nothing; the group is proven by the BACKGROUNDED
    // child's death. Mutating stop()'s `kill(-pid)` to `kill(pid)` orphans
    // that child (alive) and must fail this test.
    const pidFile = join(mkdtempSync(join(tmpdir(), "pm-pid-")), "child.pid");
    const { manager, sent } = rig({ stopGraceMs: 5_000 });
    const id = startId(
      manager.start({ command: `sleep 30 & echo $! > ${pidFile}; wait` }, null),
    );
    await waitFor(sent, id, (x) => x.status === "running");
    // Let the backgrounded child exist and its pid land on disk.
    await expect
      .poll(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim())
      .toBeTruthy();
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    manager.stop({ processId: id });
    await waitFor(sent, id, (x) => x.status !== "running");
    // The grandchild must be gone — group-signalled, not orphaned alive.
    await expect
      .poll(() => {
        try {
          process.kill(childPid, 0); // probe liveness; throws ESRCH when dead
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const { manager, sent } = rig({ stopGraceMs: 400 });
    // `exec node` REPLACES the shell, so our direct child is a process that
    // installs a no-op SIGTERM handler and thus ignores it — only SIGKILL
    // after the grace ends it. Deterministic across shells (unlike a shell
    // `trap`, whose semantics differ macOS vs the Linux container).
    const id = startId(
      manager.start(
        {
          command:
            "exec node -e \"process.on('SIGTERM',()=>{}); console.log('UP'); setInterval(()=>{}, 1000)\"",
        },
        null,
      ),
    );
    // Wait until the handler is actually installed (it prints UP right after),
    // or an early SIGTERM would hit node still booting and kill it by default.
    await waitFor(sent, id, (x) => (x.tail ?? "").includes("UP"));
    manager.stop({ processId: id });
    const p = await waitFor(sent, id, (x) => x.status !== "running");
    expect(p.status).toBe("stopped");
    expect(p.signal).toBe("SIGKILL");
  });

  it("escalates the SIGKILL to the whole GROUP, not just the leader", async () => {
    const { manager, sent } = rig({ stopGraceMs: 300 });
    const gpidFile = join(mkdtempSync(join(tmpdir(), "pm-esc-")), "gchild.pid");
    // A backgrounded grandchild that IGNORES SIGTERM: at stop the shell leader
    // dies on SIGTERM, but this survives it — only the escalation SIGKILL sent
    // to the GROUP (-pid) reaches it. MUTATION-PROOF: the escalation's
    // kill(-pid)→kill(pid) targets the already-dead leader, leaving this alive
    // (and holding the pipe open, so status never leaves running).
    const id = startId(
      manager.start(
        {
          command: `node -e "process.on('SIGTERM',()=>{}); console.log('UP'); setInterval(()=>{}, 1000)" & echo $! > ${gpidFile}; wait`,
        },
        null,
      ),
    );
    await waitFor(sent, id, (x) => (x.tail ?? "").includes("UP"));
    const gpid = Number(readFileSync(gpidFile, "utf8").trim());
    manager.stop({ processId: id });
    await expect
      .poll(
        () => {
          try {
            process.kill(gpid, 0);
            return true; // still alive
          } catch {
            return false; // ESRCH — the group SIGKILL reached it
          }
        },
        { timeout: 5_000 },
      )
      .toBe(false);
    try {
      process.kill(gpid, "SIGKILL"); // defensive; already dead on the happy path
    } catch {
      // already gone
    }
  });
});

describe("watches", () => {
  it("exit watch fires when the process ends", async () => {
    const { manager, sent } = rig();
    const id = startId(manager.start({ command: "sleep 0.1" }, null));
    manager.watch({ processId: id, kind: "exit", prompt: "report" }, null);
    const p = await waitFor(
      sent,
      id,
      (x) => x.watches[0]?.status === "triggered",
    );
    expect(p.watches[0]?.trigger).toBe("exited");
  });

  it("pattern watch fires on a substring split across chunks, once only", async () => {
    const { manager, sent } = rig();
    // Two writes with a gap so the pattern straddles a chunk boundary.
    const id = startId(
      manager.start(
        { command: "printf 'REA'; sleep 0.2; printf 'DY\\n'; sleep 5" },
        null,
      ),
    );
    manager.watch(
      { processId: id, kind: "pattern", pattern: "READY", prompt: "go" },
      null,
    );
    const p = await waitFor(
      sent,
      id,
      (x) => x.watches[0]?.status === "triggered",
    );
    expect(p.watches[0]?.trigger).toBe("matched");
    // One-shot: it does not re-trigger while the process keeps running.
    expect(p.status).toBe("running");
    manager.stop({ processId: id });
  });

  it("silence watch fires after a quiet gap, and output RESETS the clock", async () => {
    // The injectable clock + an observed entry's output delta drive the SAME
    // onOutput/sweep path a real child's stdout does (real pipes reaching
    // onOutput are covered by the spawn + tail tests).
    let clock = 1_000_000;
    const { manager, sent } = rig({ sweepIntervalMs: 5, now: () => clock });
    manager.observeUpsert(
      {
        ref: "obs-s",
        command: "chatty",
        status: "running",
        startedAt: new Date().toISOString(),
        wantsWake: false,
      },
      null,
    );
    manager.watch(
      {
        processId: "obs-s",
        kind: "silence",
        silenceSeconds: 1,
        prompt: "quiet",
      },
      null,
    );
    const tick = () => new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 4; i += 1) {
      clock += 900;
      manager.observeUpsert(
        {
          ref: "obs-s",
          command: "chatty",
          status: "running",
          startedAt: new Date().toISOString(),
          wantsWake: false,
          outputDelta: "tick\n",
        },
        null,
      );
      await tick();
    }
    // 3.6s of clock past arm, but every 0.9s of it reset the window, so a
    // WORKING reset is still armed. MUTATION-PROOF: drop `lastOutputAt = now()`
    // in onOutput and this reads `triggered`.
    expect(latest(sent, "obs-s").watches[0]?.status).toBe("armed");
    clock += 1_100;
    const p = await waitFor(
      sent,
      "obs-s",
      (x) => x.watches[0]?.status === "triggered",
    );
    expect(p.watches[0]?.trigger).toBe("silent");
  });

  it("expires an armed watch past its deadline to `expired`, never triggered", async () => {
    // Drive time through the injectable clock so the 60s minimum expiry is
    // reachable in the test without real waiting.
    let clock = 1_000_000;
    const { manager, sent } = rig({ sweepIntervalMs: 20, now: () => clock });
    const id = startId(manager.start({ command: "sleep 30" }, null));
    manager.watch(
      {
        processId: id,
        kind: "pattern",
        pattern: "ZZZ",
        prompt: "x",
        expiresInSeconds: 60,
      },
      null,
    );
    expect(latest(sent, id).watches[0]?.status).toBe("armed");
    clock += 61_000; // past the 60s deadline
    const p = await waitFor(
      sent,
      id,
      (x) => x.watches[0]?.status === "expired",
    );
    // Expiry is terminal for the watch and never becomes a trigger.
    expect(p.watches[0]?.trigger).toBeUndefined();
    manager.stop({ processId: id });
  });

  it("a watch armed without expiresInSeconds expires in one hour; an explicit one wins", () => {
    // The default is what an un-tuned watch on an idle process holds the box
    // awake for, so it is pinned in wall-clock terms, not by the constant.
    const clock = 1_000_000;
    const { manager, sent } = rig({ now: () => clock });
    const id = startId(manager.start({ command: "sleep 30" }, null));
    manager.watch({ processId: id, kind: "exit", prompt: "report" }, null);
    manager.watch(
      {
        processId: id,
        kind: "exit",
        prompt: "slow CI",
        expiresInSeconds: 86_400,
      },
      null,
    );
    const expiries = latest(sent, id).watches.map((w) =>
      Date.parse(w.expiresAt),
    );
    expect(expiries).toEqual([clock + 3_600_000, clock + 86_400_000]);
    manager.stop({ processId: id });
  });

  it("a silence watch's default lifetime starts after its silence window", () => {
    // Without the offset a 2h silence watch would expire before it could
    // ever fire (expiry is swept first).
    const clock = 1_000_000;
    const { manager, sent } = rig({ now: () => clock });
    const id = startId(manager.start({ command: "sleep 30" }, null));
    manager.watch(
      {
        processId: id,
        kind: "silence",
        silenceSeconds: 7_200,
        prompt: "it went quiet",
      },
      null,
    );
    const expiries = latest(sent, id).watches.map((w) =>
      Date.parse(w.expiresAt),
    );
    expect(expiries).toEqual([clock + (7_200 + 3_600) * 1000]);
    manager.stop({ processId: id });
  });

  it("arming a watch on an already-exited process triggers immediately", async () => {
    const { manager, sent } = rig();
    const id = startId(manager.start({ command: "true" }, null));
    await waitFor(sent, id, (x) => x.status === "exited");
    const res = manager.watch(
      { processId: id, kind: "pattern", pattern: "nope", prompt: "late" },
      null,
    );
    expect(res.ok).toBe(true);
    expect(latest(sent, id).watches.at(-1)?.status).toBe("triggered");
    expect(latest(sent, id).watches.at(-1)?.trigger).toBe("exited");
  });
});

describe("caps", () => {
  it("refuses the N+1 process and the N+1 watch with readable words", async () => {
    const { manager } = rig();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PROCESSES_PER_SANDBOX; i += 1) {
      ids.push(startId(manager.start({ command: "sleep 30" }, null)));
    }
    const over = manager.start({ command: "sleep 30" }, null);
    expect(over.ok).toBe(false);
    expect(String(over.error)).toContain(String(MAX_PROCESSES_PER_SANDBOX));

    for (let i = 0; i < MAX_WATCHES_PER_PROCESS; i += 1) {
      manager.watch({ processId: ids[0]!, kind: "exit", prompt: "w" }, null);
    }
    const overWatch = manager.watch(
      { processId: ids[0]!, kind: "exit", prompt: "w" },
      null,
    );
    expect(overWatch.ok).toBe(false);
    for (const id of ids) manager.stop({ processId: id });
  });
});

describe("status", () => {
  it("returns a bounded tail and lists all processes", async () => {
    const { manager } = rig();
    const id = startId(manager.start({ command: "echo hello; sleep 5" }, null));
    await new Promise((r) => setTimeout(r, 150));
    const one = manager.status({ processId: id });
    expect(one.ok).toBe(true);
    expect((one.result as { tail: string }).tail).toContain("hello");
    const list = manager.status({});
    expect(Array.isArray(list.result)).toBe(true);
    manager.stop({ processId: id });
  });

  it("keeps only the LAST TAIL_BUFFER_CHARS of a noisy process", async () => {
    const { manager, sent } = rig();
    // ~200k of output; the tail must hold the end, not the start.
    const id = startId(
      manager.start({ command: "yes ABCDEFGHIJ | head -c 200000" }, null),
    );
    await waitFor(sent, id, (x) => x.status === "exited");
    const tail = (manager.status({ processId: id }).result as { tail: string })
      .tail;
    expect(tail.length).toBeLessThanOrEqual(64_000);
  });
});

describe("teardown", () => {
  it("close() SIGTERMs running children so teardown leaves nothing alive", async () => {
    const { manager, sent } = rig();
    const pidFile = join(mkdtempSync(join(tmpdir(), "pm-td-")), "pid");
    const id = startId(
      manager.start({ command: `echo $$ > ${pidFile}; sleep 60` }, null),
    );
    await waitFor(sent, id, (x) => x.status === "running");
    await expect
      .poll(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim())
      .toBeTruthy();
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    void id;

    manager.close(); // idempotent — the afterEach call is a harmless no-op

    // MUTATION-PROOF: drop the SIGTERM in close() and this child stays alive.
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return true; // still alive
          } catch {
            return false; // ESRCH — dead
          }
        },
        { timeout: 5_000 },
      )
      .toBe(false);
  });
});

describe("observed entries (the native-task mirror)", () => {
  const snapshot = (over: Record<string, unknown> = {}) => ({
    ref: "obs-1",
    command: "native task",
    status: "running" as const,
    startedAt: new Date().toISOString(),
    wantsWake: false,
    ...over,
  });

  it("a late running snapshot after terminal is inert (the terminal freeze)", () => {
    const { manager, sent } = rig();
    manager.observeUpsert(snapshot(), null);
    manager.observeUpsert(snapshot({ status: "exited", exitCode: 0 }), null);
    const frames = sent.length;
    // MUTATION-PROOF: drop the running-only guard and this resurrects.
    manager.observeUpsert(snapshot(), null);
    expect(latest(sent, "obs-1").status).toBe("exited");
    expect(sent.length).toBe(frames); // and silently — no frame churn
  });

  it("a failed snapshot lands its error in the tail (the watch excerpt source)", () => {
    const { manager, sent } = rig();
    manager.observeUpsert(snapshot(), null);
    manager.observeUpsert(
      snapshot({ status: "exited", error: "boom went the build" }),
      null,
    );
    const one = manager.status({ processId: "obs-1" });
    expect((one.result as { tail: string }).tail).toContain(
      "[task failed: boom went the build]",
    );
    expect(latest(sent, "obs-1").status).toBe("exited");
  });

  it("deltas ride the shared tail ring (bounded, keeps the END)", () => {
    const { manager } = rig();
    manager.observeUpsert(snapshot(), null);
    manager.observeUpsert(
      snapshot({ outputDelta: "x".repeat(100_000) + "THE-END" }),
      null,
    );
    const tail = (
      manager.status({ processId: "obs-1" }).result as {
        tail: string;
      }
    ).tail;
    expect(tail.length).toBeLessThanOrEqual(64_000);
    expect(tail.endsWith("THE-END")).toBe(true);
  });

  it("cancelWatch cancels exactly one armed watch, once", () => {
    const { manager, sent } = rig();
    manager.observeUpsert(snapshot(), null);
    const armed = manager.watch(
      { processId: "obs-1", kind: "exit", prompt: "wake" },
      null,
    );
    const watchId = (armed.result as { watchId: string }).watchId;
    expect(manager.cancelWatch("obs-1", watchId)).toBe(true);
    expect(latest(sent, "obs-1").watches[0]?.status).toBe("canceled");
    expect(manager.cancelWatch("obs-1", watchId)).toBe(false); // inert now
    expect(manager.cancelWatch("obs-1", "nope")).toBe(false);
  });
});

describe("the turn-end safety net", () => {
  it("arms a default exit watch on running processes with no watch", async () => {
    const { manager, sent } = rig();
    const id = startId(manager.start({ command: "sleep 5" }, null));

    const armed = manager.armTurnEndSafetyNet({
      conversationId: "cv-end",
      turnId: "t-end",
    });

    expect(armed).toBe(1);
    const p = latest(sent, id);
    expect(p.watches).toHaveLength(1);
    expect(p.watches[0]?.status).toBe("armed");
    expect(p.watches[0]?.kind).toBe("exit");
    expect(p.watches[0]?.prompt).toBe(TURN_END_SAFETY_NET_PROMPT);
    // Context-less process → the ending turn's context is the fallback
    // (the frame flattens watch context into conversationId/turnId).
    expect(p.watches[0]?.conversationId).toBe("cv-end");
    expect(p.watches[0]?.turnId).toBe("t-end");
    manager.stop({ processId: id });
  });

  it("prefers the process's own arm-time context over the fallback", async () => {
    // The honest origin: the chat where the task was STARTED — a net re-arm
    // from a watch- or cron-sourced turn must not point the report at a
    // hidden automation conversation.
    const { manager, sent } = rig();
    const id = startId(
      manager.start(
        { command: "sleep 5" },
        { conversationId: "cv-origin", turnId: "t-origin" },
      ),
    );

    manager.armTurnEndSafetyNet({
      conversationId: "cv-automation",
      turnId: "t-automation",
    });

    const p = latest(sent, id);
    expect(p.watches[0]?.conversationId).toBe("cv-origin");
    expect(p.watches[0]?.turnId).toBe("t-origin");
    manager.stop({ processId: id });
  });

  it("skips processes that already have an armed watch — no double report", async () => {
    const { manager } = rig();
    const id = startId(manager.start({ command: "sleep 5" }, null));
    manager.watch({ processId: id, kind: "exit", prompt: "mine" }, null);

    const armed = manager.armTurnEndSafetyNet({
      conversationId: "cv",
      turnId: "t",
    });

    expect(armed).toBe(0);
    manager.stop({ processId: id });
  });

  it("skips terminal processes — their completion was visible to the turn", async () => {
    const { manager, sent } = rig();
    const id = startId(manager.start({ command: "true" }, null));
    await waitFor(sent, id, (x) => x.status !== "running");

    const armed = manager.armTurnEndSafetyNet({
      conversationId: "cv",
      turnId: "t",
    });

    expect(armed).toBe(0);
    expect(latest(sent, id).watches).toHaveLength(0);
  });

  it("covers OBSERVED harness-native tasks the same way", async () => {
    const { manager, sent } = rig();
    manager.observeUpsert(
      {
        ref: "native-1",
        command: "native build",
        status: "running",
        startedAt: new Date().toISOString(),
        wantsWake: false,
      },
      null,
    );

    const armed = manager.armTurnEndSafetyNet({
      conversationId: "cv",
      turnId: "t",
    });

    expect(armed).toBe(1);
    const p = latest(sent, "native-1");
    expect(p.watches[0]?.status).toBe("armed");
    expect(p.watches[0]?.prompt).toBe(TURN_END_SAFETY_NET_PROMPT);
  });

  it("is inert after close", () => {
    const { manager } = rig();
    manager.start({ command: "sleep 5" }, null);
    manager.close();
    expect(
      manager.armTurnEndSafetyNet({ conversationId: "cv", turnId: "t" }),
    ).toBe(0);
  });
});

describe("the busy signal (keep-awake's engagement read)", () => {
  it("every frame carries lastOutputAt (refreshed by output) and cpuBusy", async () => {
    const { manager, sent } = rig();
    const id = startId(
      manager.start({ command: "echo a; sleep 0.2; echo b; sleep 5" }, null),
    );
    const first = latest(sent, id);
    expect(first.cpuBusy).toBe(false);
    expect(typeof first.lastOutputAt).toBe("string");
    const after = await waitFor(
      sent,
      id,
      (p) => p.tail?.includes("b") === true,
    );
    expect(Date.parse(after.lastOutputAt!)).toBeGreaterThanOrEqual(
      Date.parse(first.lastOutputAt!),
    );
    manager.stop({ processId: id });
  });

  it("a CPU verdict that CHANGES sends a frame at once; a spawned child is judged by its own group", async () => {
    let busy = false;
    const probe = scriptedProbe({ group: () => busy });
    const { manager, sent } = rig({ cpuProbe: probe });
    const id = startId(manager.start({ command: "sleep 5" }, null));
    expect(latest(sent, id).cpuBusy).toBe(false);

    busy = true;
    const up = await waitFor(sent, id, (p) => p.cpuBusy === true);
    expect(up.status).toBe("running");
    busy = false;
    await waitFor(sent, id, (p) => p.cpuBusy === false);
    manager.stop({ processId: id });
  });

  it("an observed task (no pid) takes the sandbox-wide verdict", async () => {
    let sandbox = false;
    const { manager, sent } = rig({
      cpuProbe: scriptedProbe({ sandbox: () => sandbox }),
    });
    manager.observeUpsert(
      {
        ref: "native-1",
        command: "native build",
        status: "running",
        startedAt: new Date().toISOString(),
        wantsWake: false,
      },
      null,
    );
    sandbox = true;
    await waitFor(sent, "native-1", (p) => p.cpuBusy === true);
  });

  it("a process that ends is forgotten by the probe and reads idle", async () => {
    const probe = scriptedProbe({ group: () => true });
    const { manager, sent } = rig({ cpuProbe: probe });
    const id = startId(manager.start({ command: "sleep 0.1" }, null));
    const done = await waitFor(sent, id, (p) => p.status === "exited");
    expect(done.cpuBusy).toBe(false);
    expect(probe.forgotten.length).toBeGreaterThan(0);
  });
});

describe("watch origin", () => {
  it("an agent's own watch is origin 'agent'; the safety net and the implicit wake are 'platform'", async () => {
    const { manager, sent } = rig();
    const mine = startId(manager.start({ command: "sleep 5" }, null));
    manager.watch({ processId: mine, kind: "exit", prompt: "mine" }, null);
    expect(latest(sent, mine).watches[0]?.origin).toBe("agent");

    const quiet = startId(manager.start({ command: "sleep 5" }, null));
    manager.armTurnEndSafetyNet({ conversationId: "cv", turnId: "t" });
    expect(latest(sent, quiet).watches[0]?.origin).toBe("platform");

    manager.stop({ processId: mine });
    manager.stop({ processId: quiet });
  });
});
