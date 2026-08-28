import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessBackgroundTask } from "@onecli/agent-protocol";
import { createJcodeBackgroundTasks } from "./jcode-background";

/**
 * The jcode registry reader against REAL files — the format facts here were
 * verified against the exact vendored source and a live container, and the
 * wantsWake mapping is the load-bearing one: `notify` defaults TRUE on every
 * background bash call, so reading it as wake intent would fire a platform
 * wake turn for every fire-and-forget task.
 */

const rig = () => {
  const dir = mkdtempSync(join(tmpdir(), "jbg-"));
  return { dir, tasks: createJcodeBackgroundTasks({ dir }) };
};

const statusFile = (
  dir: string,
  id: string,
  over: Record<string, unknown> = {},
): void => {
  writeFileSync(
    join(dir, `${id}.status.json`),
    JSON.stringify({
      task_id: id,
      tool_name: "bash",
      display_name: "sleep 20;",
      session_id: "session_x",
      status: "running",
      exit_code: null,
      error: null,
      started_at: "2026-08-09T06:21:51.525Z",
      completed_at: null,
      pid: null,
      owner_pid: 50,
      detached: false,
      notify: true, // jcode's serde default — present on every real file
      wake: false,
      progress: null,
      event_history: [],
      ...over,
    }),
  );
};

describe("wake intent (the critical mapping)", () => {
  it("a DEFAULT task (notify=true, wake=false) does NOT want a wake", async () => {
    // MUTATION-PROOF: map wantsWake = notify||wake and this fails — which is
    // exactly the regression that would wake-turn-spam every task.
    const { dir, tasks } = rig();
    statusFile(dir, "t1");
    const [task] = await tasks.poll();
    expect(task?.wantsWake).toBe(false);
  });

  it("wake=true wants a wake, and a mid-run flip is seen on the next poll", async () => {
    const { dir, tasks } = rig();
    statusFile(dir, "t1", { wake: true });
    expect((await tasks.poll())[0]?.wantsWake).toBe(true);
    statusFile(dir, "t1", { wake: false }); // the bg tool revoked it
    expect((await tasks.poll())[0]?.wantsWake).toBe(false);
  });
});

describe("what gets mirrored", () => {
  it("only bash tasks — jcode-internal kinds are skipped", async () => {
    const { dir, tasks } = rig();
    statusFile(dir, "t1");
    statusFile(dir, "t2", { tool_name: "selfdev" });
    const snapshots = await tasks.poll();
    expect(snapshots.map((t) => t.ref)).toEqual(["t1"]);
  });

  it("a corrupt status file is skipped without killing the poll", async () => {
    const { dir, tasks } = rig();
    statusFile(dir, "t1");
    writeFileSync(join(dir, "t2.status.json"), '{"task_id": "t2", trunca');
    const snapshots = await tasks.poll();
    expect(snapshots.map((t) => t.ref)).toEqual(["t1"]);
  });

  it("an empty or missing registry dir is an empty poll", async () => {
    const tasks = createJcodeBackgroundTasks({
      dir: join(tmpdir(), "jbg-never-created"),
    });
    expect(await tasks.poll()).toEqual([]);
  });
});

describe("status mapping", () => {
  it("completed → exited with the exit code", async () => {
    const { dir, tasks } = rig();
    statusFile(dir, "t1", {
      status: "completed",
      exit_code: 0,
      completed_at: "2026-08-09T06:22:11.543Z",
    });
    const [task] = await tasks.poll();
    expect(task).toMatchObject({
      status: "exited",
      exitCode: 0,
      endedAt: "2026-08-09T06:22:11.543Z",
    });
  });

  it("failed → exited carrying the error; a user cancel → stopped", async () => {
    const { dir, tasks } = rig();
    statusFile(dir, "t1", { status: "failed", error: "boom" });
    statusFile(dir, "t2", { status: "failed", error: "Cancelled by user" });
    const byRef = new Map((await tasks.poll()).map((t) => [t.ref, t]));
    expect(byRef.get("t1")).toMatchObject({ status: "exited", error: "boom" });
    expect(byRef.get("t2")).toMatchObject({ status: "stopped" });
    expect(byRef.get("t2")?.error).toBeUndefined();
  });
});

describe("output tailing", () => {
  it("consumes output incrementally across polls", async () => {
    const { dir, tasks } = rig();
    statusFile(dir, "t1");
    writeFileSync(join(dir, "t1.output"), "first\n");
    expect((await tasks.poll())[0]?.outputDelta).toBe("first\n");
    writeFileSync(join(dir, "t1.output"), "first\nsecond\n");
    expect((await tasks.poll())[0]?.outputDelta).toBe("second\n");
    // Nothing new → no delta at all.
    expect((await tasks.poll())[0]?.outputDelta).toBeUndefined();
  });

  it("a runaway backlog is skipped ahead with a distinctive gap marker", async () => {
    const { dir, tasks } = rig();
    statusFile(dir, "t1");
    writeFileSync(join(dir, "t1.output"), "x".repeat(600_000));
    const delta = (await tasks.poll())[0]?.outputDelta ?? "";
    expect(delta).toContain("onecli: output gap");
    expect(delta.length).toBeLessThanOrEqual(64_000 + 200);
  });

  it("a task with no output file still mirrors, without a delta", async () => {
    const { dir, tasks } = rig();
    statusFile(dir, "t1");
    const [task] = await tasks.poll();
    expect(task?.ref).toBe("t1");
    expect(task?.outputDelta).toBeUndefined();
  });
});

describe("hostile-file hardening (the dir is agent-writable)", () => {
  it("a named-pipe status file is SKIPPED, not read — otherwise its read would hang the poll forever (the wedge)", async () => {
    const { dir, tasks } = rig();
    // A FIFO with no writer: a plain readFile() blocks on open until a writer
    // appears — i.e. forever — permanently wedging the observer (its
    // overlap-skip guard never clears). A directory/oversized file only
    // THROWS and is caught, so it can't prove the guard; the FIFO can.
    execFileSync("mkfifo", [join(dir, "pipe.status.json")]);
    statusFile(dir, "good");
    // MUTATION-PROOF: drop the isFile() gate and this poll never resolves →
    // the race returns "HUNG".
    const result = await Promise.race([
      tasks.poll(),
      new Promise<"HUNG">((r) => setTimeout(() => r("HUNG"), 3_000)),
    ]);
    expect(result).not.toBe("HUNG");
    expect((result as HarnessBackgroundTask[]).map((t) => t.ref)).toEqual([
      "good",
    ]);
  });

  it("an oversized status file is skipped unread", async () => {
    const { dir, tasks } = rig();
    statusFile(dir, "good");
    writeFileSync(join(dir, "huge.status.json"), "x".repeat(100_000));
    expect((await tasks.poll()).map((t) => t.ref)).toEqual(["good"]);
  });

  it("a task_id that is a path (traversal) is rejected by the token charset", async () => {
    const { dir, tasks } = rig();
    statusFile(dir, "trav", { task_id: "../../etc/passwd" });
    // Parse fails on the charset → skipped; no `${task_id}.output` is ever
    // joined, so nothing outside the dir can be read.
    expect(await tasks.poll()).toEqual([]);
  });
});
