import { readFileSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Harness, HarnessEvent } from "@onecli/agent-protocol";

/**
 * THE RUNTIME LIFECYCLE, LIVE: the real adapter against the real pinned
 * jcode binary, with only the model provider mocked. What only the real
 * daemon can show:
 *
 * - The keep-alive keeps a prewarmed runtime past jcode's own idle exit
 *   (`IDLE_TIMEOUT_SECS` = 300 s, compiled in), so this scenario waits it
 *   out on purpose. Opt in with JCODE_LIVE_IDLE=1 on top of the gate.
 * - A daemon killed between turns is relaunched in place: no `onFailure`,
 *   and the held session's next turn reattaches on its own ref with its
 *   history intact (the model sees the earlier turn's words).
 * - A second death inside the window, a death under a turn, and dispose
 *   each behave as the adapter promises, leaving no process behind.
 *
 *   JCODE_LIVE_TEST=1 pnpm --filter @onecli/sandbox-supervisor \
 *     exec vitest run src/harness/jcode-runtime.live.test.ts
 */
const LIVE = Boolean(process.env.JCODE_LIVE_TEST);
const LIVE_IDLE = LIVE && Boolean(process.env.JCODE_LIVE_IDLE);

/** Injected into the managed config.toml (the incident suite's pattern). */
let mockProviderToml = "";
vi.mock("../home/fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("../home/fs")>();
  return {
    ...original,
    writeManagedFile: (path: string, content: string, mode: number) => {
      if (path.endsWith("config.toml")) {
        content =
          content.replace(
            "[provider]\n",
            '[provider]\ndefault_model = "mockai:mock-model"\n',
          ) + mockProviderToml;
      }
      return original.writeManagedFile(path, content, mode);
    },
  };
});

const { createJcodeHarness } = await import("./jcode");
const { startMockProvider } = await import("./testing/mock-provider");
type MockScript = import("./testing/mock-provider").MockScript;

/** A short real-path home: the daemon's unix socket must fit SUN_LEN, and
 * jcode refuses bash under a symlinked path component (macOS /tmp). */
const shortHome = () => mkdtempSync(`${realpathSync("/tmp")}/ocl-`);

const collect = async (
  iterable: AsyncIterable<HarnessEvent>,
): Promise<HarnessEvent[]> => {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
};

const textOf = (events: HarnessEvent[]) =>
  events
    .filter((event) => event.type === "text.delta")
    .map((event) => (event as { text: string }).text)
    .join("");

/** The daemon's pid, from the instance's own registry (as the SDK reads it). */
const daemonPid = (homeDir: string): number => {
  const jcodeHome = join(homeDir, ".jcode-home");
  const registry = JSON.parse(
    readFileSync(join(jcodeHome, "servers.json"), "utf8"),
  ) as Record<string, { socket?: string; pid?: number }>;
  const socket = join(jcodeHome, "run", "jcode.sock");
  const pid = Object.values(registry).find((e) => e.socket === socket)?.pid;
  if (!pid) throw new Error("no daemon pid in servers.json");
  return pid;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (predicate: () => boolean, label: string, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};

describe("jcode runtime live gate", () => {
  it.skipIf(!LIVE)("builds the adapter without launching anything", () => {
    expect(createJcodeHarness().capabilities.resume).toBe(true);
  });
});

describe.skipIf(!LIVE)("the runtime lifecycle (live jcode)", () => {
  let mock: Awaited<ReturnType<typeof startMockProvider>> | undefined;
  let harness: Harness | undefined;
  const failures: string[] = [];

  const start = async (options?: { script?: MockScript }) => {
    mock = await startMockProvider({
      longMs: 60_000,
      keepaliveMs: 2_000,
      ...(options?.script && { script: options.script }),
    });
    mockProviderToml = `
[providers.mockai]
type = "openai-compatible"
base_url = "http://127.0.0.1:${mock.port}/v1"
api_key = "sk-mock"
default_model = "mock-model"
models = [{ id = "mock-model" }]
`;
    failures.length = 0;
    harness = createJcodeHarness();
    harness.onFailure((reason) => failures.push(reason));
    return { harness, mock, homeDir: shortHome() };
  };

  afterEach(async () => {
    await harness?.dispose();
    await mock?.close();
    harness = undefined;
    mock = undefined;
  });

  it.skipIf(!LIVE_IDLE)(
    "a prewarmed runtime outlives jcode's 300 s idle exit",
    async () => {
      const { harness, homeDir } = await start();
      harness.prewarm?.(homeDir);
      await until(
        () => existsDaemon(homeDir),
        "the daemon to register",
        60_000,
      );
      const pid = daemonPid(homeDir);

      await new Promise((resolve) => setTimeout(resolve, 330_000));
      expect(alive(pid)).toBe(true);
      expect(failures).toEqual([]);

      const session = await harness.startSession({ homeDir });
      const events = await collect(session.runTurn({ message: "hello" }));
      expect(events.at(-1)?.type).toBe("turn.done");
      expect(textOf(events)).toContain("Quick answer");
      // Still the very daemon the prewarm launched.
      expect(daemonPid(homeDir)).toBe(pid);
    },
    420_000,
  );

  it("a daemon killed between turns is relaunched in place; the held session keeps its transcript", async () => {
    const { harness, mock, homeDir } = await start();
    const session = await harness.startSession({ homeDir });
    const marker = `remember-${Date.now()}`;
    const first = await collect(session.runTurn({ message: marker }));
    expect(first.at(-1)?.type).toBe("turn.done");
    const ref = session.sessionRef;
    const firstPid = daemonPid(homeDir);

    process.kill(firstPid, "SIGKILL");
    await until(
      () => !alive(firstPid) && daemonPidOrNull(homeDir) !== firstPid,
      "the relaunched daemon",
      30_000,
    );
    expect(failures).toEqual([]);

    const killedAt = Date.now();
    const second = await collect(session.runTurn({ message: "and now?" }));
    expect(second.at(-1)?.type).toBe("turn.done");
    expect(textOf(second)).toContain("Quick answer");
    expect(session.sessionRef).toBe(ref);
    // The transcript survived: the model's request for turn 2 carries
    // turn 1's message, so the relaunched daemon resumed the SAME session.
    const last = mock.requests.at(-1);
    expect(last?.lastUser).toContain("and now?");
    expect(last?.userTexts.some((text) => text.includes(marker))).toBe(true);
    expect(failures).toEqual([]);
    expect(Date.now() - killedAt).toBeLessThan(30_000);
  }, 180_000);

  it("a stop that lands while the turn reattaches sends nothing to the model", async () => {
    const { harness, mock, homeDir } = await start();
    const session = await harness.startSession({ homeDir });
    await collect(session.runTurn({ message: "first" }));
    const firstPid = daemonPid(homeDir);
    process.kill(firstPid, "SIGKILL");
    await until(
      () => daemonPidOrNull(homeDir) !== firstPid && existsDaemon(homeDir),
      "the relaunched daemon",
      30_000,
    );
    const requestsBefore = mock.requests.length;
    // The stop goes in synchronously behind the turn's first step, so it
    // lands inside the reattach (the attach + preference round trips).
    const turn = collect(session.runTurn({ message: "NEVER-SENT" }));
    await session.abort();
    const events = await turn;
    expect(events).toEqual([{ type: "turn.done" }]);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(mock.requests.length).toBe(requestsBefore);
    expect(
      mock.requests.some((request) => request.lastUser.includes("NEVER-SENT")),
    ).toBe(false);
    // The stop was that turn's alone.
    const next = await collect(session.runTurn({ message: "and now" }));
    expect(next.at(-1)?.type).toBe("turn.done");
    expect(failures).toEqual([]);
  }, 120_000);

  it("a second death inside the window fails the sandbox, once", async () => {
    const { harness, homeDir } = await start();
    const session = await harness.startSession({ homeDir });
    await collect(session.runTurn({ message: "one" }));
    const firstPid = daemonPid(homeDir);
    process.kill(firstPid, "SIGKILL");
    await until(
      () => daemonPidOrNull(homeDir) !== firstPid && !alive(firstPid),
      "the relaunched daemon",
      30_000,
    );
    await until(() => existsDaemon(homeDir), "its registry entry", 30_000);
    process.kill(daemonPid(homeDir), "SIGKILL");
    await until(() => failures.length > 0, "onFailure", 30_000);
    // Two honest readings of one race, both fatal and reported once: the
    // kill lands after the relaunch is up (a second death in the window),
    // or while it still dials its keep-alive (the relaunch failed).
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/again, within|harness relaunch failed/);
  }, 180_000);

  it("a death under a turn fails the sandbox; the turn ends with an error", async () => {
    const { harness, mock, homeDir } = await start();
    const session = await harness.startSession({ homeDir });
    const turn = collect(session.runTurn({ message: "LONGRUN go" }));
    await until(
      () => mock.requests.some((request) => request.kind === "long"),
      "the long turn to reach the model",
      60_000,
    );
    const killedAt = Date.now();
    const killed = daemonPid(homeDir);
    process.kill(killed, "SIGKILL");
    const events = await turn;
    expect(events.at(-1)?.type).toBe("error");
    expect(failures).toHaveLength(1);
    expect(Date.now() - killedAt).toBeLessThan(10_000);
    // Not relaunched under the turn: a relaunch registers a new daemon
    // within ~150 ms (measured), and none ever does.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(daemonPid(homeDir)).toBe(killed);
  }, 180_000);

  it("dispose leaves no daemon and reports nothing", async () => {
    const { harness, homeDir } = await start();
    const session = await harness.startSession({ homeDir });
    await collect(session.runTurn({ message: "hi" }));
    const pid = daemonPid(homeDir);
    const at = Date.now();
    await harness.dispose();
    expect(Date.now() - at).toBeLessThan(5_000);
    await until(() => !alive(pid), "the daemon to exit", 10_000);
    expect(failures).toEqual([]);
  }, 120_000);

  it("after a relaunch nothing the dead daemon owned stays running in the mirror: its bash task is settled, and our own lead is never read as a helper", async () => {
    // Two traps, both measured live. jcode reconciles status files
    // orphaned by a previous server process at startup
    // (`reconcile_orphaned_tasks`), so the bash task must read settled.
    // And a relaunched daemon lists every persisted session, our own lead
    // included, as a detached HEADLESS swarm member until it is reattached:
    // read as a helper, it would hold the sandbox awake for 30 minutes.
    let armed = false;
    const { harness, homeDir } = await start({
      script: ({ lastUser }) => {
        if (!lastUser.includes("ARM") || armed) return undefined;
        armed = true;
        return {
          kind: "tool_call",
          name: "bash",
          argsJson: JSON.stringify({
            command: "sleep 600",
            run_in_background: true,
          }),
        };
      },
    });
    const session = await harness.startSession({ homeDir });
    await collect(session.runTurn({ message: "ARM a long job" }));
    const tasks = harness.backgroundTasks;
    if (!tasks) throw new Error("jcode mirrors background tasks");
    const running = async () =>
      (await tasks.poll()).filter((task) => task.status === "running");
    let before: Awaited<ReturnType<typeof running>> = [];
    for (let i = 0; i < 100 && before.length === 0; i += 1) {
      before = await running();
      if (before.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(before).toHaveLength(1);

    const firstPid = daemonPid(homeDir);
    process.kill(firstPid, "SIGKILL");
    await until(
      () => daemonPidOrNull(homeDir) !== firstPid && existsDaemon(homeDir),
      "the relaunched daemon",
      30_000,
    );
    let after = before;
    for (let i = 0; i < 100 && after.length > 0; i += 1) {
      after = await running();
      if (after.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(after).toEqual([]);
    expect(failures).toEqual([]);
  }, 120_000);
});

const daemonPidOrNull = (homeDir: string): number | null => {
  try {
    return daemonPid(homeDir);
  } catch {
    return null;
  }
};

const existsDaemon = (homeDir: string) => {
  const pid = daemonPidOrNull(homeDir);
  return pid !== null && alive(pid);
};
