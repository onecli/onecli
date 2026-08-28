import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ExecDisconnectedError } from "../types";
import type {
  DockerEngineApi,
  ExecCreateConfig,
  ExecInspectResult,
} from "./engine-api";
import {
  buildDockerExecConfig,
  createDockerExecBackend,
  type DockerExecTarget,
} from "./exec-backend";

/**
 * The docker exec-backend's config invariants and its exit/settle/dispose
 * lifecycle — the most intricate logic on this arm — exercised here with a
 * fake engine (the real-daemon proof lives in the opt-in e2e).
 */

describe("buildDockerExecConfig", () => {
  // Byte-pin the load-bearing invariants, mirroring the kube guest-command
  // pin: exec lands as node, in the durable home, with USER/LOGNAME set and
  // NO setpriv identity wrapper (CapDrop:ALL would make it EPERM).
  it("runs as node in the durable home with the shared payload, no wrapper", () => {
    const cfg = buildDockerExecConfig({ kind: "shell" }, true);
    expect(cfg.User).toBe("node");
    expect(cfg.Env).toEqual([
      "HOME=/workspace/.home",
      "USER=node",
      "LOGNAME=node",
    ]);
    expect(cfg.Cmd[0]).toBe("sh");
    expect(cfg.Cmd[1]).toBe("-c");
    expect(cfg.Cmd[2]).toContain("mkdir -p /workspace/.home");
    expect(cfg.Cmd[2]).toContain("exec bash -l");
    // No identity-drop wrapper on this substrate.
    expect(cfg.Cmd).not.toContain("setpriv");
    expect(cfg.Cmd.join(" ")).not.toContain("--reset-env");
  });

  it("attaches stderr only without a TTY (the TTY stream carries both)", () => {
    expect(buildDockerExecConfig({ kind: "shell" }, true).AttachStderr).toBe(
      false,
    );
    expect(
      buildDockerExecConfig({ kind: "exec", command: "ls" }, false)
        .AttachStderr,
    ).toBe(true);
  });

  it("carries the sftp payload untouched", () => {
    const cfg = buildDockerExecConfig({ kind: "sftp" }, false);
    expect(cfg.Cmd[2]).toContain("exec /usr/lib/openssh/sftp-server");
  });
});

interface FakeEngine extends DockerEngineApi {
  socket: PassThrough;
  created: ExecCreateConfig[];
  inspectBehavior: () => Promise<ExecInspectResult>;
}

const makeEngine = (): FakeEngine => {
  const socket = new PassThrough();
  const fake: FakeEngine = {
    socket,
    created: [],
    inspectBehavior: () => Promise.resolve({ Running: false, ExitCode: 0 }),
    negotiateVersion: () => Promise.resolve("1.44"),
    listContainers: () => Promise.resolve([]),
    execCreate: (_id, config) => {
      fake.created.push(config);
      return Promise.resolve("exec-1");
    },
    execStart: () => Promise.resolve(socket),
    execResize: () => Promise.resolve(),
    execInspect: () => fake.inspectBehavior(),
    close: () => Promise.resolve(),
  };
  return fake;
};

const TARGET: DockerExecTarget = { containerId: "c-1" };

// Fast poll timing so the exhaustion cases settle in ~ms, not the 5s the
// production budget would take.
const FAST_POLL = { intervalMs: 1, attempts: 5, disposedAttempts: 2 };

const runExec = async (engine: FakeEngine, tty = false) => {
  const backend = createDockerExecBackend(engine, FAST_POLL);
  const io = {
    stdout: new PassThrough(),
    stderr: tty ? null : new PassThrough(),
    stdin: new PassThrough(),
  };
  const handle = await backend.exec(TARGET, { kind: "shell" }, io, tty);
  return handle;
};

describe("createDockerExecBackend — lifecycle", () => {
  it("resolves the guest exit code when the stream closes", async () => {
    const engine = makeEngine();
    engine.inspectBehavior = () =>
      Promise.resolve({ Running: false, ExitCode: 7 });
    const handle = await runExec(engine);
    engine.socket.destroy();
    await expect(handle.exited).resolves.toBe(7);
  });

  it("collapses to 1 only after the budget yields no honest code", async () => {
    const engine = makeEngine();
    // A code that never lands (Running:false, ExitCode:null every inspect) is
    // not honest — the poll exhausts, then falls back to 1.
    engine.inspectBehavior = () =>
      Promise.resolve({ Running: false, ExitCode: null });
    const handle = await runExec(engine);
    engine.socket.destroy();
    await expect(handle.exited).resolves.toBe(1);
  });

  it("waits out a slow-to-publish code instead of fabricating 1", async () => {
    const engine = makeEngine();
    // The real daemon race: the stream closes a beat before ExecInspect
    // settles Running→false with the code. The first inspects still show the
    // exec running; the honest 7 lands only later. The poll must report 7,
    // never the fabricated 1 that a give-up-early budget produced live.
    let calls = 0;
    engine.inspectBehavior = () => {
      calls += 1;
      return calls < 3
        ? Promise.resolve({ Running: true, ExitCode: null })
        : Promise.resolve({ Running: false, ExitCode: 7 });
    };
    const handle = await runExec(engine);
    engine.socket.destroy();
    await expect(handle.exited).resolves.toBe(7);
  });

  it("does not read a code from a Running:false/null transient", async () => {
    const engine = makeEngine();
    // Some daemons flip Running→false a beat before writing the code. The poll
    // must not treat that null as the answer — it keeps polling and reports the
    // real code once it lands.
    let calls = 0;
    engine.inspectBehavior = () => {
      calls += 1;
      return calls < 3
        ? Promise.resolve({ Running: false, ExitCode: null })
        : Promise.resolve({ Running: false, ExitCode: 3 });
    };
    const handle = await runExec(engine);
    engine.socket.destroy();
    await expect(handle.exited).resolves.toBe(3);
  });

  it("rejects with ExecDisconnectedError when the transport errors", async () => {
    const engine = makeEngine();
    const handle = await runExec(engine);
    engine.socket.emit("error", new Error("boom"));
    await expect(handle.exited).rejects.toBeInstanceOf(ExecDisconnectedError);
  });

  it("dispose() tears the socket down and settles exited — idempotently", async () => {
    const engine = makeEngine();
    engine.inspectBehavior = () =>
      Promise.resolve({ Running: false, ExitCode: 0 });
    const handle = await runExec(engine);
    // Calling dispose more than once must not throw or double-settle.
    handle.dispose();
    handle.dispose();
    await expect(handle.exited).resolves.toBe(0);
    expect(engine.socket.destroyed).toBe(true);
  });

  it("settles a disposed-but-still-running exec on the fast budget", async () => {
    const engine = makeEngine();
    // Client disconnected mid-command: docker keeps the detached exec running,
    // so ExecInspect reports Running forever. dispose() must not hold the
    // session open on the long budget — it settles (to 1, the code is moot).
    let calls = 0;
    engine.inspectBehavior = () => {
      calls += 1;
      return Promise.resolve({ Running: true, ExitCode: null });
    };
    const handle = await runExec(engine);
    handle.dispose();
    await expect(handle.exited).resolves.toBe(1);
    // The fast budget bounds the polling — not the long natural-exit budget.
    expect(calls).toBeLessThanOrEqual(FAST_POLL.disposedAttempts);
  });

  it("only exposes resize on the TTY arm", async () => {
    const noTty = await runExec(makeEngine(), false);
    expect(noTty.resize).toBeUndefined();
    const tty = await runExec(makeEngine(), true);
    expect(typeof tty.resize).toBe("function");
  });
});
