import { describe, expect, it } from "vitest";
import type { RunnerSandboxChannel } from "@onecli/agent-protocol";
import {
  classifySandbox,
  vanishedSandboxes,
  type ClassifyInput,
} from "./reconcile-classify";

/**
 * The reconciler's verdict on one container, from the control plane's facts
 * (whichever copy holds the sandbox's socket) rather than one process's
 * memory. Every arm here used to read the local ws server; a wrong verdict
 * either reports a healthy sandbox stopped (its turns fail, it is recreated
 * mid-work) or leaves a dead one believed running (turns wait out the
 * ceiling), so each state and both graces are pinned.
 */

const NOW = 10_000_000;
const GRACES = {
  bootDialInMs: 180_000,
  droppedMs: 900_000,
  inheritedMs: 180_000,
};

const channel = (
  state: string,
  since: number | null = null,
  containerRef: string | null = "ctr-1",
): RunnerSandboxChannel => ({ containerRef, channel: state, since });

const input = (overrides: Partial<ClassifyInput> = {}): ClassifyInput => ({
  snapshot: {
    containerRef: "ctr-1",
    running: true,
    phase: null,
    resumable: true,
  },
  believed: "running",
  channel: channel("held", NOW - 1_000),
  now: NOW,
  reconcilerSince: NOW - 3_600_000,
  sessions: true,
  graces: GRACES,
  ...overrides,
});

const dead = {
  containerRef: "ctr-1",
  running: false,
  phase: null,
  resumable: true,
};

describe("classifySandbox", () => {
  it.each([
    ["held by a live copy", channel("held", NOW - 1)],
    ["awaiting its first connect", channel("awaiting", NOW - 1)],
    ["mid-start (spawn not recorded yet)", channel("starting", null)],
  ])("a running container %s is left alone", (_label, facts) => {
    expect(classifySandbox(input({ channel: facts }))).toBe("leave");
  });

  it("a drop a live copy saw is reconnecting for the session grace, then channelless", () => {
    const at = (since: number) =>
      classifySandbox(input({ channel: channel("dropped", since) }));
    expect(at(NOW - GRACES.droppedMs + 1)).toBe("leave");
    expect(at(NOW - GRACES.droppedMs - 1)).toBe("channelless");
  });

  it("a lost holder gets the inherited grace from its last heartbeat", () => {
    const at = (since: number) =>
      classifySandbox(input({ channel: channel("lost", since) }));
    expect(at(NOW - GRACES.inheritedMs + 1)).toBe("leave");
    expect(at(NOW - GRACES.inheritedMs - 1)).toBe("channelless");
  });

  it("the inherited grace counts from when THIS copy became reconciler, if later", () => {
    // The holder died long ago, but this copy only just took over: its
    // supervisors may be reconnecting to a fleet that just came back.
    const verdict = classifySandbox(
      input({
        channel: channel("lost", NOW - 3_600_000),
        reconcilerSince: NOW - 1_000,
      }),
    );
    expect(verdict).toBe("leave");
  });

  it("an unrecorded channel (a container from before channel records) gets the inherited grace from the takeover", () => {
    const at = (reconcilerSince: number) =>
      classifySandbox(
        input({ channel: channel("none", null), reconcilerSince }),
      );
    expect(at(NOW - GRACES.inheritedMs + 1)).toBe("leave");
    expect(at(NOW - GRACES.inheritedMs - 1)).toBe("channelless");
  });

  it("an unknown channel state reads as `none`", () => {
    // `as` would let a newer control plane's word through as one of ours;
    // only `none` is safe (a dead container is dead, a live one waits out
    // the inherited grace).
    expect(
      classifySandbox(
        input({ channel: channel("future-state", null), reconcilerSince: NOW }),
      ),
    ).toBe("leave");
    expect(
      classifySandbox(
        input({
          channel: channel("future-state", null),
          reconcilerSince: NOW - GRACES.inheritedMs - 1,
        }),
      ),
    ).toBe("channelless");
    expect(
      classifySandbox(
        input({ snapshot: dead, channel: channel("future-state", null) }),
      ),
    ).toBe("dead");
  });

  it.each([
    ["this runner hands out no sessions", { sessions: false }],
    [
      "the container was spawned without one",
      {
        snapshot: {
          containerRef: "ctr-1",
          running: true,
          phase: null,
          resumable: false,
        },
      },
    ],
  ])("no grace at all when %s: a drop is a death", (_label, overrides) => {
    for (const facts of [
      channel("dropped", NOW - 1),
      channel("lost", NOW - 1),
      channel("none", null),
    ]) {
      expect(classifySandbox(input({ ...overrides, channel: facts }))).toBe(
        "channelless",
      );
    }
  });

  it("a running channelless container whose row is parked is a stray", () => {
    for (const believed of ["stopped", "failed"]) {
      expect(
        classifySandbox(
          input({ believed, channel: channel("dropped", NOW - 3_600_000) }),
        ),
      ).toBe("stray");
    }
  });

  it("a dead container with no channel is dead, never reconnecting", () => {
    // A dead container has no supervisor to come back: the grace ends here.
    for (const facts of [
      channel("dropped", NOW - 1),
      channel("lost", NOW - 1),
      channel("none", null),
    ]) {
      expect(classifySandbox(input({ snapshot: dead, channel: facts }))).toBe(
        "dead",
      );
    }
  });

  it("a dead container still held, or mid-start, is left alone", () => {
    expect(
      classifySandbox(input({ snapshot: dead, channel: channel("held", NOW) })),
    ).toBe("leave");
    expect(
      classifySandbox(
        input({ snapshot: dead, channel: channel("starting", null) }),
      ),
    ).toBe("leave");
  });

  describe("boot crash: a dead spawn that never connected", () => {
    const awaiting = (since: number) => channel("awaiting", since);

    it("is a boot crash once the dial-in grace has passed since the spawn", () => {
      expect(
        classifySandbox(
          input({
            snapshot: dead,
            channel: awaiting(NOW - GRACES.bootDialInMs - 1),
          }),
        ),
      ).toBe("boot-crash");
    });

    it("waits out the grace: a slow boot is not a crash", () => {
      expect(
        classifySandbox(
          input({
            snapshot: dead,
            channel: awaiting(NOW - GRACES.bootDialInMs + 1),
          }),
        ),
      ).toBe("leave");
    });

    it("waits for a genuinely terminal phase (Pending is merely not running yet)", () => {
      const at = (phase: string) =>
        classifySandbox(
          input({
            snapshot: { ...dead, phase },
            channel: awaiting(NOW - GRACES.bootDialInMs - 1),
          }),
        );
      expect(at("Pending")).toBe("leave");
      expect(at("Failed")).toBe("boot-crash");
      expect(at("Succeeded")).toBe("boot-crash");
    });

    it("a running container awaiting its first connect is booting, never a crash", () => {
      expect(
        classifySandbox(input({ channel: awaiting(NOW - 3_600_000) })),
      ).toBe("leave");
    });
  });

  it("facts about a different container are not about this one", () => {
    // The control plane's current container is ctr-2 (a newer spawn): its
    // channel says nothing about ctr-1, and a report about ctr-1 would be
    // inert anyway (observed-container fence).
    for (const facts of [
      channel("dropped", NOW - 3_600_000, "ctr-2"),
      channel("awaiting", NOW - 3_600_000, "ctr-2"),
    ]) {
      expect(classifySandbox(input({ channel: facts }))).toBe("leave");
      expect(classifySandbox(input({ snapshot: dead, channel: facts }))).toBe(
        "leave",
      );
    }
  });

  it("no channel facts at all read as an unrecorded channel", () => {
    expect(
      classifySandbox(
        input({
          channel: undefined,
          reconcilerSince: NOW - GRACES.inheritedMs - 1,
        }),
      ),
    ).toBe("channelless");
  });
});

describe("vanishedSandboxes (believed running, no container, two passes)", () => {
  it("reports only on the second consecutive observation", () => {
    const statuses = {
      "sb-1": "running",
      "sb-2": "running",
      "sb-3": "stopped",
    };
    const present = new Set(["sb-2"]);

    const first = vanishedSandboxes(statuses, present, new Set());
    expect(first.report).toEqual([]);
    expect([...first.missing]).toEqual(["sb-1"]);

    const second = vanishedSandboxes(statuses, present, first.missing);
    expect(second.report).toEqual(["sb-1"]);
    expect([...second.missing]).toEqual([]);
  });

  it("reappearance, or no longer believed running, resets the clock", () => {
    const previous = new Set(["sb-1", "sb-2"]);
    const result = vanishedSandboxes(
      { "sb-1": "running", "sb-2": "stopping" },
      new Set(["sb-1"]),
      previous,
    );
    expect(result.report).toEqual([]);
    expect([...result.missing]).toEqual([]);
  });

  it("no statuses (no listing this pass) observes nothing", () => {
    const result = vanishedSandboxes(undefined, new Set(), new Set(["sb-1"]));
    expect(result.report).toEqual([]);
    expect([...result.missing]).toEqual([]);
  });
});
