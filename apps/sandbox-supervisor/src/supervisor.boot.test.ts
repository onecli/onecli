import { mkdtempSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  SupervisorMessage,
  SupervisorTransport,
  SupervisorWorkItem,
} from "@onecli/agent-protocol";
import type { SupervisorAddon } from "./addons";
import { createFakeHarness } from "./harness/fake";
import { platformToolsSocketPath } from "./platform-tools";
import { runSupervisor } from "./supervisor";

/**
 * The boot overlap: the desktop (seconds to come up) used to be
 * awaited before the supervisor even dialed the runner, so every wake paid
 * for it before the runner heard `ready`. Now the entrypoint hands the
 * desktop's start in as `pending` and:
 *
 * - `ready` goes out at once, without waiting for it, and the harness
 *   launches at once too;
 * - the first turn runs at once: its session starts without the display
 *   and receives it (`setEnv`) when the desktop settles, so its next shell
 *   has a screen. Only a child that must INHERIT `DISPLAY` from this
 *   process waits: a scheduled gate's shell;
 * - once it settles, the doc teaches the display, the addon's tools and
 *   fragments are there, its report goes out, and a session that captured
 *   the headless doc restarts on its next turn, carrying the display.
 */

const config = (homeDir: string) => ({
  homeDir,
  model: undefined,
  effort: undefined,
  instructions: "You are the test agent.",
  agentName: "Ada",
  channels: [],
  peers: [],
  connections: [],
  harness: "fake",
  runnerWsUrl: undefined,
  bootstrapToken: undefined,
  sandboxId: undefined,
  outboundAttachments: false,
  previews: true,
});

const home = () => mkdtempSync(join(tmpdir(), "sup-boot-"));

/** The advertised tool names, asked the way the MCP bridge asks. */
const advertisedTools = (): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(platformToolsSocketPath(), () => {
      socket.write(`${JSON.stringify({ id: "t", op: "tools" })}\n`);
    });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const reply = JSON.parse(buffer.slice(0, newline)) as {
        tools?: { name: string }[];
      };
      socket.end();
      resolve((reply.tools ?? []).map((t) => t.name));
    });
    socket.on("error", reject);
  });

const createTestTransport = () => {
  const sent: SupervisorMessage[] = [];
  const queue: SupervisorWorkItem[] = [];
  let notify: (() => void) | undefined;
  const api = {
    sent,
    push(item: SupervisorWorkItem) {
      queue.push(item);
      notify?.();
      notify = undefined;
    },
    of<K extends SupervisorMessage["kind"]>(kind: K) {
      return sent.filter(
        (m): m is Extract<SupervisorMessage, { kind: K }> => m.kind === kind,
      );
    },
    async until(predicate: () => boolean, label: string) {
      for (let i = 0; i < 600; i += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    async finish(run: Promise<void>) {
      api.push({ kind: "shutdown" });
      await run;
    },
    transport: {
      async *incoming(): AsyncIterable<SupervisorWorkItem> {
        for (;;) {
          while (queue.length > 0) {
            const item = queue.shift();
            if (!item) continue;
            yield item;
            if (item.kind === "shutdown") return;
          }
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      },
      send(message: SupervisorMessage) {
        sent.push(message);
      },
      close() {
        return Promise.resolve();
      },
    } satisfies SupervisorTransport,
  };
  return api;
};

/** A boot the test settles by hand: `settle` resolves `pending`. */
const deferredBoot = () => {
  let settle!: (bound: { addon?: SupervisorAddon }) => void;
  const pending = new Promise<{ addon?: SupervisorAddon }>((resolve) => {
    settle = resolve;
  });
  return { pending, settle };
};

/** An addon standing in for the hosted desktop's: one tool, one fragment. */
const standInAddon = (): SupervisorAddon => ({
  fragments: [{ id: "screen", title: "Your screen", body: "SCREEN-TAUGHT" }],
  tools: [
    {
      name: "stand_in_screen_tool",
      description: "A tool that exists only with the screen.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  reservedPorts: [5900],
  report: (send) => send({ kind: "desktop.state", viewable: true }),
});

const deliver = (turnId: string, gate?: string): SupervisorWorkItem => ({
  kind: "turn.deliver",
  turnId,
  conversationId: "cv-a",
  message: "hello",
  ...(gate !== undefined && { gate }),
});

const savedDisplay = process.env.DISPLAY;
afterEach(() => {
  if (savedDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = savedDisplay;
});

describe("the boot overlap: ready never waits for the desktop", () => {
  it("sends ready and runs the first turn while the desktop is still coming up; the session gets the display when it lands", async () => {
    delete process.env.DISPLAY;
    const boot = deferredBoot();
    const harness = createFakeHarness();
    const t = createTestTransport();
    const run = runSupervisor(config(home()), harness, t.transport, {
      pending: boot.pending,
    });

    await t.until(() => t.of("ready").length === 1, "ready");
    t.push(deliver("t1"));
    // The turn runs to its end with no desktop in sight: the session
    // started without a display (none to give).
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    expect(t.of("turn.result")[0]?.status).toBe("done");
    expect(harness.sessionStarts).toEqual([{}]);
    expect(harness.sessions[0]?.envUpdates).toEqual([]);

    // The desktop comes up the way bootDesktop leaves it: exported into
    // this process's environment before `pending` settles. The live
    // session is handed exactly that, once.
    process.env.DISPLAY = ":1";
    boot.settle({});
    await t.until(
      () => (harness.sessions[0]?.envUpdates.length ?? 0) > 0,
      "the display to reach the session",
    );
    expect(harness.sessions[0]?.envUpdates).toEqual([{ DISPLAY: ":1" }]);

    // Its next turn restarts the session on its own ref (the doc now
    // teaches the screen), and the restart carries the display from the
    // start; the settled display never lands twice.
    const ref = t.of("turn.result")[0]?.sessionRef;
    t.push(deliver("t2"));
    await t.until(() => t.of("turn.result").length === 2, "the second turn");
    expect(harness.sessionStarts).toEqual([
      {},
      { resumeSessionRef: ref, env: { DISPLAY: ":1" } },
    ]);
    expect(harness.sessions[0]?.envUpdates).toEqual([{ DISPLAY: ":1" }]);
    expect(harness.sessions[1]?.envUpdates).toEqual([]);
    await t.finish(run);
  });

  it("a conversation whose first turn came after the desktop starts its session with the display and is never restarted for it", async () => {
    delete process.env.DISPLAY;
    const boot = deferredBoot();
    const harness = createFakeHarness();
    const t = createTestTransport();
    const run = runSupervisor(config(home()), harness, t.transport, {
      pending: boot.pending,
    });
    await t.until(() => t.of("ready").length === 1, "ready");
    process.env.DISPLAY = ":1";
    boot.settle({});
    // Nothing live to mark: the settle must not leave a stale flag behind
    // for a session that does not exist yet.
    await new Promise((resolve) => setTimeout(resolve, 20));

    t.push(deliver("t1"));
    await t.until(() => t.of("turn.result").length === 1, "t1");
    t.push(deliver("t2"));
    await t.until(() => t.of("turn.result").length === 2, "t2");
    expect(harness.sessionStarts).toEqual([{ env: { DISPLAY: ":1" } }]);
    expect(harness.sessions[0]?.envUpdates).toEqual([]);
    await t.finish(run);
  });

  it("a desktop that never came up changes nothing: no restart, no env, for a session that was already live", async () => {
    delete process.env.DISPLAY;
    const boot = deferredBoot();
    const harness = createFakeHarness();
    const t = createTestTransport();
    const run = runSupervisor(config(home()), harness, t.transport, {
      pending: boot.pending,
    });
    await t.until(() => t.of("ready").length === 1, "ready");
    t.push(deliver("t1"));
    await t.until(() => t.of("turn.result").length === 1, "t1");

    // bootDesktop's failure shape: `pending` settles with no display
    // exported and no addon.
    boot.settle({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    t.push(deliver("t2"));
    await t.until(() => t.of("turn.result").length === 2, "t2");
    expect(harness.sessionStarts).toEqual([{}]);
    expect(harness.sessions[0]?.envUpdates).toEqual([]);
    await t.finish(run);
  });

  it("a scheduled gate still waits for the desktop: its shell inherits DISPLAY from this process", async () => {
    delete process.env.DISPLAY;
    const boot = deferredBoot();
    const harness = createFakeHarness();
    const t = createTestTransport();
    const run = runSupervisor(config(home()), harness, t.transport, {
      pending: boot.pending,
    });
    await t.until(() => t.of("ready").length === 1, "ready");
    t.push(deliver("g1", 'echo "$DISPLAY"'));
    // Claimed (alive, heartbeating), parked: no gate ran, no session started.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(t.of("turn.result")).toHaveLength(0);
    expect(harness.sessionStarts).toHaveLength(0);

    process.env.DISPLAY = ":1";
    boot.settle({});
    await t.until(() => t.of("turn.result").length === 1, "the gated turn");
    // The gate saw the display (it printed it, so the agent was woken with
    // it), and that is the whole reason it waited.
    const notice = t
      .of("event")
      .find((m) => m.turnId === "g1" && m.event.type === "notice");
    expect(notice?.event).toMatchObject({
      type: "notice",
      text: expect.stringContaining(":1") as string,
    });
    expect(t.of("turn.result")[0]?.status).toBe("done");
    await t.finish(run);
  });

  it("re-renders the doc for the display and binds the addon (fragment, tool, report) once the desktop settles", async () => {
    delete process.env.DISPLAY;
    const homeDir = home();
    const boot = deferredBoot();
    const t = createTestTransport();
    const run = runSupervisor(
      config(homeDir),
      createFakeHarness(),
      t.transport,
      {
        pending: boot.pending,
      },
    );
    await t.until(() => t.of("ready").length === 1, "ready");
    const doc = () => readFileSync(join(homeDir, "CLAUDE.md"), "utf8");
    // Before: headless wording, no addon, no report.
    expect(doc()).toContain("headless chromium");
    expect(doc()).not.toContain("SCREEN-TAUGHT");
    expect(t.of("desktop.state")).toEqual([]);
    expect(await advertisedTools()).not.toContain("stand_in_screen_tool");

    // The desktop comes up the way bootDesktop leaves it: DISPLAY exported
    // into this process's environment before `pending` settles.
    process.env.DISPLAY = ":1";
    boot.settle({ addon: standInAddon() });
    await t.until(() => t.of("desktop.state").length > 0, "the addon report");
    expect(doc()).toContain("a desktop with Chrome");
    expect(doc()).toContain("SCREEN-TAUGHT");
    expect(t.of("desktop.state")[0]?.viewable).toBe(true);
    expect(await advertisedTools()).toContain("stand_in_screen_tool");
    await t.finish(run);
  });

  it("launches the harness before ready and before the desktop (its sessions learn DISPLAY later, per session)", async () => {
    delete process.env.DISPLAY;
    const boot = deferredBoot();
    const harness = createFakeHarness();
    const t = createTestTransport();
    const prewarms: { display: string | undefined; beforeReady: boolean }[] =
      [];
    harness.prewarm = () => {
      prewarms.push({
        display: process.env.DISPLAY,
        beforeReady: t.of("ready").length === 0,
      });
    };
    const run = runSupervisor(config(home()), harness, t.transport, {
      pending: boot.pending,
    });
    await t.until(() => t.of("ready").length === 1, "ready");
    // Exactly one launch, ahead of ready, with no display to inherit, and
    // before any turn asked.
    expect(prewarms).toEqual([{ display: undefined, beforeReady: true }]);
    expect(harness.sessionStarts).toHaveLength(0);

    process.env.DISPLAY = ":1";
    boot.settle({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The settle launches nothing a second time.
    expect(prewarms).toHaveLength(1);
    await t.finish(run);
  });

  it("without a pending boot the harness is launched before ready, as the blocking boot always did", async () => {
    const harness = createFakeHarness();
    let prewarmedBeforeReady: boolean | undefined;
    const t = createTestTransport();
    harness.prewarm = () => {
      prewarmedBeforeReady = t.of("ready").length === 0;
    };
    const run = runSupervisor(config(home()), harness, t.transport);
    await t.until(() => t.of("ready").length === 1, "ready");
    expect(prewarmedBeforeReady).toBe(true);
    await t.finish(run);
  });

  it("a desktop that settles after the run has ended binds nothing (no addon report, no apps outliving the teardown)", async () => {
    const boot = deferredBoot();
    const harness = createFakeHarness();
    const t = createTestTransport();
    const run = runSupervisor(config(home()), harness, t.transport, {
      pending: boot.pending,
    });
    await t.until(() => t.of("ready").length === 1, "ready");
    await t.finish(run);

    boot.settle({ addon: standInAddon() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.of("desktop.state")).toEqual([]);
  });

  it("a boot that rejects (contract breach) still lets turns run, without a desktop", async () => {
    delete process.env.DISPLAY;
    const t = createTestTransport();
    const run = runSupervisor(
      config(home()),
      createFakeHarness(),
      t.transport,
      {
        pending: Promise.reject(new Error("boom")),
      },
    );
    t.push(deliver("t1"));
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    expect(t.of("turn.result")[0]?.status).toBe("done");
    await t.finish(run);
  });

  it("a home that goes read-only while a gated turn still waits on the boot fails that turn with the read-only code, and the run still ends", async () => {
    // The two features meet here: since ready no longer waits for the
    // desktop, a gated turn can be parked on the boot when the home
    // freezes. It must close as a read-only failure (the storage sentence,
    // and a budgeted restart), never run its gate or a session on the
    // frozen home, and never hold the teardown open on a desktop that may
    // take its time.
    const boot = deferredBoot();
    const homeDir = home();
    let options = "rw,relatime,discard";
    const harness = createFakeHarness();
    const t = createTestTransport();
    const run = runSupervisor(config(homeDir), harness, t.transport, {
      pending: boot.pending,
      readMounts: () =>
        [
          `tmpfs ${homeDir} tmpfs rw,nodev,relatime 0 0`,
          `/dev/sdb ${homeDir} ext4 ${options} 0 0`,
        ].join("\n"),
      homeWatchIntervalMs: 5,
    });
    await t.until(() => t.of("ready").length === 1, "ready");
    t.push(deliver("t1", "true"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.of("turn.result")).toEqual([]);

    // The kernel's own reading after an ext4 error on a 6.15+ kernel.
    options = "rw,relatime,discard,emergency_ro";
    await t.until(() => t.of("unhealthy").length === 1, "the report");
    expect(t.of("unhealthy")[0]?.code).toBe("home_read_only");

    // The desktop settles late: the parked turn proceeds into a dead run.
    boot.settle({});
    await run;
    const [result] = t.of("turn.result");
    expect(result?.turnId).toBe("t1");
    expect(result?.status).toBe("failed");
    expect(result?.errorCode).toBe("home_read_only");
  }, 30_000);
});
