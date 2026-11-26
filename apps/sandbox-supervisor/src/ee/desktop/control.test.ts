import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SupervisorAddonHost } from "../../addons";
import { browserHoldPath } from "../../browser-driver/paths";
import {
  browserHoldAt,
  createDesktopControl,
  DESKTOP_RELEASED_STEER_MESSAGE,
  DESKTOP_TAKEN_STEER_MESSAGE,
  desktopTools,
  type BrowserHold,
  type ScreenControl,
} from "./control";

/**
 * The control arm: the control plane's flip starts/stops the input server
 * and tells every live turn what to do, through the supervisor's steer
 * inbox. The screen is a fake with the same handle; whether a turn is live
 * is the test's choice.
 */
const fakeScreen = () => {
  const calls: string[] = [];
  const screen: ScreenControl = {
    startControl: async () => {
      calls.push("start");
    },
    stopControl: () => {
      calls.push("stop");
    },
  };
  return { screen, calls };
};

/** The browser hold, recorded in the same call log so the order is visible. */
const fakeHold = (calls: string[]): BrowserHold => ({
  set: () => {
    calls.push("hold");
  },
  clear: () => {
    calls.push("unhold");
  },
});

const setup = (liveTurnIds: string | null | string[]) => {
  const { screen, calls } = fakeScreen();
  const steers: Array<{ id: string; message: string }> = [];
  const live =
    liveTurnIds === null
      ? []
      : Array.isArray(liveTurnIds)
        ? liveTurnIds
        : [liveTurnIds];
  const arm = createDesktopControl(screen, fakeHold(calls));
  const host: SupervisorAddonHost = {
    steerLiveTurns: (id, message) => {
      for (const turnId of live) steers.push({ id: id(turnId), message });
      return live.length;
    },
  };
  const control = {
    handle: (item: Parameters<typeof arm.handle>[0]) => arm.handle(item, host),
  };
  return { control, calls, steers };
};

describe("desktop control", () => {
  it("taking control starts the input server and tells the live turn to stop", () => {
    const { control, calls, steers } = setup("t1");
    control.handle({
      kind: "desktop.control",
      controlled: true,
      controllerName: "Alex Kim",
    });
    // The hold lands before the server: it is what refuses the agent's
    // next browser verb, and must be there before the person's input is.
    expect(calls).toEqual(["hold", "start"]);
    expect(steers).toEqual([
      { id: "desktop-taken:t1", message: DESKTOP_TAKEN_STEER_MESSAGE },
    ]);
  });

  it("releasing control stops the server, lifts the hold, and tells the live turn to continue", () => {
    const { control, calls, steers } = setup("t1");
    control.handle({ kind: "desktop.control", controlled: true });
    control.handle({ kind: "desktop.control", controlled: false });
    expect(calls).toEqual(["hold", "start", "stop", "unhold"]);
    expect(steers.map((s) => s.id)).toEqual([
      "desktop-taken:t1",
      "desktop-released:t1",
    ]);
    expect(steers[1]?.message).toBe(DESKTOP_RELEASED_STEER_MESSAGE);
  });

  it("is idempotent: a re-sent state flips nothing and steers nothing", () => {
    const { control, calls, steers } = setup("t1");
    control.handle({ kind: "desktop.control", controlled: false }); // already
    control.handle({ kind: "desktop.control", controlled: true });
    control.handle({ kind: "desktop.control", controlled: true });
    expect(calls).toEqual(["hold", "start"]);
    expect(steers).toHaveLength(1);
  });

  it("steers EVERY live turn, each under its own id, on take and on release", () => {
    const { control, steers } = setup(["t1", "t2"]);
    control.handle({ kind: "desktop.control", controlled: true });
    control.handle({ kind: "desktop.control", controlled: false });
    expect(steers.map((s) => s.id)).toEqual([
      "desktop-taken:t1",
      "desktop-taken:t2",
      "desktop-released:t1",
      "desktop-released:t2",
    ]);
  });

  it("with no turn live, the server still flips and nothing is steered", () => {
    const { control, calls, steers } = setup(null);
    control.handle({ kind: "desktop.control", controlled: true });
    control.handle({ kind: "desktop.control", controlled: false });
    expect(calls).toEqual(["hold", "start", "stop", "unhold"]);
    expect(steers).toEqual([]);
  });

  it("a control server that fails to start is logged, never thrown into the reader loop", async () => {
    const { screen, calls } = fakeScreen();
    screen.startControl = () => Promise.reject(new Error("no server"));
    const control = createDesktopControl(screen, fakeHold(calls));
    expect(() =>
      control.handle(
        { kind: "desktop.control", controlled: true },
        { steerLiveTurns: () => 0 },
      ),
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });

  it("a hold that cannot be written is logged, and the flip and the steer still happen", () => {
    const { screen, calls } = fakeScreen();
    const broken: BrowserHold = {
      set: () => {
        throw new Error("read-only home");
      },
      clear: () => {
        throw new Error("read-only home");
      },
    };
    const control = createDesktopControl(screen, broken);
    let steered = 0;
    const host: SupervisorAddonHost = {
      steerLiveTurns: () => {
        steered += 1;
        return 1;
      },
    };
    expect(() =>
      control.handle({ kind: "desktop.control", controlled: true }, host),
    ).not.toThrow();
    expect(() =>
      control.handle({ kind: "desktop.control", controlled: false }, host),
    ).not.toThrow();
    expect(calls).toEqual(["start", "stop"]);
    expect(steered).toBe(2);
  });

  it("the tool asks for one bounded reason and nothing else", () => {
    expect(desktopTools).toHaveLength(1);
    const [tool] = desktopTools;
    expect(tool?.name).toBe("request_human_takeover");
    expect(tool?.execute).toBeUndefined(); // control-plane executed
    expect(tool?.inputSchema).toMatchObject({
      required: ["reason"],
      properties: { reason: { type: "string", maxLength: 300 } },
    });
  });
});

describe("the browser hold on disk", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0))
      rmSync(h, { recursive: true, force: true });
  });

  it("is the driver's marker file under the agent's home, in a 0700 directory", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "onecli-hold-"));
    homes.push(homeDir);
    const hold = browserHoldAt(homeDir);
    const path = browserHoldPath(homeDir);
    expect(existsSync(path)).toBe(false);
    hold.set();
    expect(existsSync(path)).toBe(true);
    expect(statSync(join(homeDir, ".onecli")).mode & 0o777).toBe(0o700);
    hold.set(); // a second take is fine
    hold.clear();
    expect(existsSync(path)).toBe(false);
    hold.clear(); // and so is clearing twice
  });
});
