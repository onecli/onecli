import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJcodeSwarmTasks } from "./jcode-swarm";

vi.mock("../log", () => ({ log: vi.fn() }));

/**
 * A scripted stand-in for the daemon's legacy socket, speaking the exact
 * v0.78.1 one-shot shape: read one JSON line, write one JSON line, close.
 */

interface CommRequest {
  type: string;
  id: number;
  session_id: string;
}

/** Returns the reply LINE for a request, or null to close without replying. */
type Responder = (request: CommRequest) => string | null;

const members = (id: number, roster: unknown[]): string =>
  JSON.stringify({ type: "comm_members", id, members: roster });

const errorReply = (id: number, message: string): string =>
  JSON.stringify({ type: "error", id, message });

const helper = (
  sessionId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  session_id: sessionId,
  friendly_name: "otter",
  files_touched: [],
  status,
  task_label: "build the thing",
  is_headless: true,
  ...extra,
});

// mkdtemp under /tmp directly: macOS's default tmpdir overflows SUN_LEN.
const dirs: string[] = [];
const servers: Server[] = [];

const startFakeDaemon = async (
  respond: Responder,
): Promise<{ socketPath: string }> => {
  const dir = mkdtempSync("/tmp/jcode-swarm-test-");
  dirs.push(dir);
  const socketPath = join(dir, "jcode.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as CommRequest;
      // The real daemon ACKS every request before the substantive reply
      // (client_lightweight_control.rs:110, live-verified) — speak the
      // exact dialect so the reader's ack-skip is always exercised.
      socket.write(`${JSON.stringify({ type: "ack", id: request.id })}\n`);
      const reply = respond(request);
      if (reply !== null) socket.write(`${reply}\n`);
      socket.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath };
};

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const makeTasks = (
  socketPath: () => string | undefined,
  leads: string[] = ["lead-1"],
) =>
  createJcodeSwarmTasks({
    legacySocketPath: socketPath,
    leadRefs: () => leads,
  });

describe("the swarm roster mirror", () => {
  it("returns nothing before the instance is up or without leads", async () => {
    expect(await makeTasks(() => undefined).poll()).toEqual([]);
    const { socketPath } = await startFakeDaemon((req) => members(req.id, []));
    expect(await makeTasks(() => socketPath, []).poll()).toEqual([]);
  });

  it("mirrors a running helper with its identity and derived start time", async () => {
    const before = Date.now();
    const { socketPath } = await startFakeDaemon((req) =>
      members(req.id, [
        helper("session_a", "running", { status_age_secs: 90 }),
      ]),
    );
    const [task] = await makeTasks(() => socketPath).poll();
    expect(task).toMatchObject({
      ref: "session_a",
      name: "otter",
      command: "swarm helper otter: build the thing",
      status: "running",
      wantsWake: false,
    });
    const startedAt = Date.parse(task?.startedAt ?? "");
    expect(startedAt).toBeLessThanOrEqual(before - 89_000);
    expect(startedAt).toBeGreaterThan(before - 120_000);
  });

  it("a finished helper exits with its report as output, emitted exactly once", async () => {
    const { socketPath } = await startFakeDaemon((req) =>
      members(req.id, [
        helper("session_a", "ready", { latest_completion_report: "all done" }),
      ]),
    );
    const tasks = makeTasks(() => socketPath);
    const [first] = await tasks.poll();
    expect(first).toMatchObject({
      status: "exited",
      outputDelta: "all done",
    });
    const [second] = await tasks.poll();
    expect(second?.status).toBe("exited");
    expect(second?.outputDelta).toBeUndefined();
    expect(second?.endedAt).toBe(first?.endedAt);
  });

  it("bare ready before any run is the pre-turn window, not a completion", async () => {
    const { socketPath } = await startFakeDaemon((req) =>
      members(req.id, [helper("session_a", "ready")]),
    );
    const tasks = makeTasks(() => socketPath);
    // TWO polls: the mapped-running first pass must not poison seenRunning —
    // a slow startup turn held in `ready` for several ticks stays running.
    expect((await tasks.poll())[0]?.status).toBe("running");
    expect((await tasks.poll())[0]?.status).toBe("running");
    expect((await tasks.poll())[0]?.status).toBe("running");
  });

  it("a reply with the wrong id is a failed query, never a roster", async () => {
    let wrongId = false;
    const { socketPath } = await startFakeDaemon((req) =>
      wrongId
        ? members(req.id + 999, [])
        : members(req.id, [helper("session_a", "running")]),
    );
    const tasks = makeTasks(() => socketPath);
    expect((await tasks.poll())[0]?.status).toBe("running");
    wrongId = true;
    // Failed query: nothing mirrored, and no fake termination synthesized.
    expect(await tasks.poll()).toEqual([]);
    wrongId = false;
    expect((await tasks.poll())[0]?.status).toBe("running");
  });

  it("a round of nothing but no-swarm refusals never terminates known helpers", async () => {
    let refuse = false;
    const { socketPath } = await startFakeDaemon((req) =>
      refuse
        ? errorReply(req.id, "Not in a swarm. Use a git repository.")
        : members(req.id, [helper("session_a", "running")]),
    );
    const tasks = makeTasks(() => socketPath);
    expect((await tasks.poll())[0]?.status).toBe("running");
    refuse = true;
    // A refusal round is a valid EMPTY state, but not proof of termination.
    expect(await tasks.poll()).toEqual([]);
    refuse = false;
    expect((await tasks.poll())[0]?.status).toBe("running");
  });

  it("ready after running is terminal even without a report", async () => {
    let status = "running";
    const { socketPath } = await startFakeDaemon((req) =>
      members(req.id, [helper("session_a", status)]),
    );
    const tasks = makeTasks(() => socketPath);
    expect((await tasks.poll())[0]?.status).toBe("running");
    status = "ready";
    expect((await tasks.poll())[0]?.status).toBe("exited");
  });

  it("maps failed, crashed, and stopped with their errors", async () => {
    const { socketPath } = await startFakeDaemon((req) =>
      members(req.id, [
        helper("session_f", "failed", { detail: "compile error" }),
        helper("session_c", "crashed"),
        helper("session_s", "stopped"),
      ]),
    );
    const tasks = await makeTasks(() => socketPath).poll();
    const byRef = new Map(tasks.map((t) => [t.ref, t]));
    expect(byRef.get("session_f")).toMatchObject({
      status: "exited",
      error: "compile error",
    });
    expect(byRef.get("session_c")).toMatchObject({
      status: "exited",
      error: "helper crashed",
    });
    expect(byRef.get("session_s")).toMatchObject({ status: "stopped" });
  });

  it("mirrors only headless members — the lead is not background work", async () => {
    const { socketPath } = await startFakeDaemon((req) =>
      members(req.id, [
        { session_id: "lead-1", files_touched: [], status: "running" },
        helper("session_a", "running"),
      ]),
    );
    const tasks = await makeTasks(() => socketPath).poll();
    expect(tasks.map((t) => t.ref)).toEqual(["session_a"]);
  });

  it("the no-swarm refusal is an empty roster, not a failure", async () => {
    const { socketPath } = await startFakeDaemon((req) =>
      errorReply(
        req.id,
        "Not in a swarm. Use a git repository to enable swarm features.",
      ),
    );
    expect(await makeTasks(() => socketPath).poll()).toEqual([]);
  });

  it("survives a malformed reply without throwing", async () => {
    const { socketPath } = await startFakeDaemon(() => "not json at all");
    expect(await makeTasks(() => socketPath).poll()).toEqual([]);
  });

  it("unions the roster across leads without duplicating helpers", async () => {
    const { socketPath } = await startFakeDaemon((req) =>
      members(req.id, [helper("session_a", "running")]),
    );
    const tasks = await makeTasks(
      () => socketPath,
      ["lead-1", "lead-2"],
    ).poll();
    expect(tasks).toHaveLength(1);
  });

  it("a running helper vanishing from a healthy roster is a termination", async () => {
    let roster: unknown[] = [helper("session_a", "running")];
    const { socketPath } = await startFakeDaemon((req) =>
      members(req.id, roster),
    );
    const tasks = makeTasks(() => socketPath);
    expect((await tasks.poll())[0]?.status).toBe("running");
    roster = [];
    const [synthetic] = await tasks.poll();
    expect(synthetic).toMatchObject({
      ref: "session_a",
      status: "stopped",
      error: "removed from the swarm roster",
      command: "swarm helper otter: build the thing",
    });
    // Tracking dropped: the termination is emitted once, then silence.
    expect(await tasks.poll()).toEqual([]);
  });

  it("a failed round never fakes a termination", async () => {
    let mode: "roster" | "broken" = "roster";
    const { socketPath } = await startFakeDaemon((req) =>
      mode === "roster"
        ? members(req.id, [helper("session_a", "running")])
        : "garbage",
    );
    const tasks = makeTasks(() => socketPath);
    expect((await tasks.poll())[0]?.status).toBe("running");
    mode = "broken";
    expect(await tasks.poll()).toEqual([]);
    // The helper is still there once the daemon answers again.
    mode = "roster";
    expect((await tasks.poll())[0]?.status).toBe("running");
  });

  it("refuses a ref over the wire cap instead of shipping it", async () => {
    const longId = "s".repeat(120);
    const { socketPath } = await startFakeDaemon((req) =>
      members(req.id, [helper(longId, "running")]),
    );
    expect(await makeTasks(() => socketPath).poll()).toEqual([]);
  });

  it("a daemon that closes without answering is a failed query, not a hang", async () => {
    const { socketPath } = await startFakeDaemon(() => null);
    expect(await makeTasks(() => socketPath).poll()).toEqual([]);
  });

  it("a re-run helper becomes a new generation with a fresh ref", async () => {
    let roster: unknown[] = [
      helper("session_a", "ready", {
        latest_completion_report: "first result",
      }),
    ];
    const { socketPath } = await startFakeDaemon((req) =>
      members(req.id, roster),
    );
    const tasks = makeTasks(() => socketPath);
    const [gen1] = await tasks.poll();
    expect(gen1).toMatchObject({
      ref: "session_a",
      status: "exited",
      outputDelta: "first result",
    });

    roster = [helper("session_a", "running")];
    const [gen2Running] = await tasks.poll();
    expect(gen2Running).toMatchObject({
      ref: "session_a~2",
      status: "running",
    });

    roster = [
      helper("session_a", "ready", {
        latest_completion_report: "second result",
      }),
    ];
    const [gen2Done] = await tasks.poll();
    expect(gen2Done).toMatchObject({
      ref: "session_a~2",
      status: "exited",
      outputDelta: "second result",
    });
  });

  it("a between-polls re-run is caught by its changed report", async () => {
    let roster: unknown[] = [
      helper("session_a", "ready", {
        latest_completion_report: "first result",
      }),
    ];
    const { socketPath } = await startFakeDaemon((req) =>
      members(req.id, roster),
    );
    const tasks = makeTasks(() => socketPath);
    expect((await tasks.poll())[0]?.status).toBe("exited");

    // The re-run started AND finished between polls — only the report moved.
    roster = [
      helper("session_a", "ready", {
        latest_completion_report: "second result",
      }),
    ];
    const [gen2] = await tasks.poll();
    expect(gen2).toMatchObject({
      ref: "session_a~2",
      status: "exited",
      outputDelta: "second result",
    });
  });

  it("an idle terminal helper replays its snapshot without churn", async () => {
    const { socketPath } = await startFakeDaemon((req) =>
      members(req.id, [
        helper("session_a", "ready", { latest_completion_report: "done" }),
      ]),
    );
    const tasks = makeTasks(() => socketPath);
    await tasks.poll();
    const [replayA] = await tasks.poll();
    const [replayB] = await tasks.poll();
    expect(replayA).toEqual(replayB);
    expect(replayA?.status).toBe("exited");
  });
});
