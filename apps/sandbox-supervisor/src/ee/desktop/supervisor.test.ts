import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  SupervisorMessage,
  SupervisorTransport,
  SupervisorWorkItem,
} from "@onecli/agent-protocol";
import { desktopControlSteerId } from "@onecli/agent-protocol";
import type { SupervisorAddon } from "../../addons";
import { createFakeHarness } from "../../harness/fake";
import { runSupervisor } from "../../supervisor";
import {
  DESKTOP_RELEASED_STEER_MESSAGE,
  DESKTOP_TAKEN_STEER_MESSAGE,
} from "./control";
import { browserHoldPath } from "../../browser-driver/paths";
import { createHostedDesktop } from "./index";

/**
 * The hosted desktop through the real supervisor:
 *
 * - A person taking the screen stops EVERY live turn, not only an
 *   unambiguous one: two conversations in flight (a person's question and a
 *   peer's message) both act on the same screen, and both are told.
 * - The viewability report: a viewable screen says so; a desktop nobody can
 *   watch, or none at all, says it cannot be viewed. Only a viewable one
 *   teaches the takeover tool.
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

const home = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

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

/**
 * The hosted desktop's addon over a stand-in screen: the real control arm,
 * tool and report, with the screen servers replaced by call records.
 */
const hostedAddon = (
  screen: { viewable: boolean; started?: boolean },
  homeDir = home("onecli-hosted-"),
) => {
  const calls: string[] = [];
  const hosted = createHostedDesktop(homeDir, {
    viewable: () => screen.viewable,
    startControl: async () => {
      calls.push("start");
    },
    stopControl: () => {
      calls.push("stop");
    },
  });
  return { addon: hosted.addon(screen.started ?? true), calls };
};

/** A turn long enough for a control flip to land inside it. */
const longScript = (): AgentEvent[] => [
  ...Array.from({ length: 150 }, (_, i) => ({
    type: "text.delta" as const,
    text: `chunk-${i}`,
  })),
  { type: "turn.done" as const },
];

const deliver = (
  turnId: string,
  conversationId: string,
): SupervisorWorkItem => ({
  kind: "turn.deliver",
  turnId,
  conversationId,
  message: "work on the screen",
});

describe("the desktop control arm through the supervisor", () => {
  it("a take and a release steer BOTH live conversations, once each", async () => {
    const { addon, calls } = hostedAddon({ viewable: true });
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-desktop-steer-")),
      createFakeHarness({ script: () => longScript() }),
      t.transport,
      { addon },
    );
    t.push(deliver("t1", "cv-a"));
    t.push(deliver("t2", "cv-b"));
    const streaming = (turnId: string) =>
      t
        .of("event")
        .some((m) => m.turnId === turnId && m.event.type === "text.delta");
    await t.until(
      () => streaming("t1") && streaming("t2"),
      "both turns to stream",
    );
    t.push({
      kind: "desktop.control",
      controlled: true,
      controllerName: "Alex",
    });
    // A re-sent flip (a poll hiccup) is inert: no second copy anywhere.
    t.push({
      kind: "desktop.control",
      controlled: true,
      controllerName: "Alex",
    });
    t.push({ kind: "desktop.control", controlled: false });
    await t.until(() => t.of("turn.result").length === 2, "both turns to end");
    await t.finish(run);

    expect(calls).toEqual(["start", "stop"]);
    for (const [turnId] of [["t1"], ["t2"]] as const) {
      const followUps = t
        .of("turn.result")
        .find((r) => r.turnId === turnId)?.followUps;
      expect(followUps).toEqual([
        { turnId: desktopControlSteerId(turnId, true), outcome: "joined" },
        { turnId: desktopControlSteerId(turnId, false), outcome: "joined" },
      ]);
      const injected = (text: string) =>
        t
          .of("event")
          .some(
            (m) =>
              m.turnId === turnId &&
              m.event.type === "text.delta" &&
              m.event.text.includes(text),
          );
      expect(injected(DESKTOP_TAKEN_STEER_MESSAGE)).toBe(true);
      expect(injected(DESKTOP_RELEASED_STEER_MESSAGE)).toBe(true);
    }
  });
});

describe("the browser hold through the supervisor", () => {
  it("a take sets the marker on the home, a release removes it", async () => {
    const homeDir = home("sup-desktop-hold-");
    const { addon } = hostedAddon({ viewable: true }, homeDir);
    const marker = browserHoldPath(homeDir);
    const t = createTestTransport();
    const run = runSupervisor(
      config(homeDir),
      createFakeHarness({ script: () => longScript() }),
      t.transport,
      { addon },
    );
    t.push(deliver("t1", "cv-a"));
    await t.until(
      () =>
        t
          .of("event")
          .some((m) => m.turnId === "t1" && m.event.type === "text.delta"),
      "the turn to stream",
    );
    t.push({ kind: "desktop.control", controlled: true });
    await t.until(() => existsSync(marker), "the hold marker to appear");
    t.push({ kind: "desktop.control", controlled: false });
    await t.until(() => !existsSync(marker), "the hold marker to go");
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);
  });

  it("a marker a previous life left is cleared at boot, before any push", () => {
    // A restart mid-takeover: the lease may be gone, and a "released" push
    // matches the fresh arm's state (skipped as a re-send), so nothing
    // would ever clear it. Boot does.
    const homeDir = home("sup-desktop-stale-hold-");
    const marker = browserHoldPath(homeDir);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, "");
    hostedAddon({ viewable: true }, homeDir);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("the viewability report", () => {
  const reportsOf = async (addon: SupervisorAddon) => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-desktop-report-")),
      createFakeHarness(),
      t.transport,
      { addon },
    );
    await t.until(() => t.of("ready").length === 1, "ready");
    await t.finish(run);
    // Sent at ready and again on the re-send beat (port discovery's first
    // tick may land before shutdown): the distinct values are the claim.
    return [...new Set(t.of("desktop.state").map((m) => m.viewable))];
  };

  it("a viewable screen says so, and teaches the takeover tool", async () => {
    const { addon } = hostedAddon({ viewable: true });
    expect(await reportsOf(addon)).toEqual([true]);
    expect(addon.tools.map((tool) => tool.name)).toEqual([
      "request_human_takeover",
    ]);
    expect(addon.fragments.map((f) => f.id)).toEqual(["desktop"]);
  });

  it("a desktop nobody can watch, or none at all, says it cannot be viewed and teaches nothing", async () => {
    for (const screen of [
      { viewable: false },
      { viewable: true, started: false },
    ]) {
      const { addon } = hostedAddon(screen);
      expect(await reportsOf(addon)).toEqual([false]);
      expect(addon.tools).toEqual([]);
      expect(addon.fragments).toEqual([]);
    }
  });

  it("a supervisor without the hosted desktop reports nothing", async () => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-desktop-none-")),
      createFakeHarness(),
      t.transport,
    );
    await t.until(() => t.of("ready").length === 1, "ready");
    await t.finish(run);
    expect(t.of("desktop.state")).toEqual([]);
  });
});
