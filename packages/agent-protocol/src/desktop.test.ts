import { describe, expect, it } from "vitest";
import {
  desktopControlSteerId,
  isPlatformSteerId,
  runnerEventSchema,
  runnerWorkItemSchema,
} from "./runner-wire";
import {
  DESKTOP_CONTROL_PORT,
  DESKTOP_VIEW_PORT,
  MAX_DESKTOP_CONTROLLER_NAME_CHARS,
  supervisorMessageSchema,
  workItemSchema,
} from "./transport";

/**
 * The desktop wire: one work item down (control taken / released), one
 * message up (the screen is viewable), one runner event carrying it to the
 * control plane, and the platform steer ids a control flip writes into a
 * live turn.
 */
describe("desktop frames", () => {
  it("the two screen ports are fixed and distinct", () => {
    expect(DESKTOP_VIEW_PORT).toBe(5900);
    expect(DESKTOP_CONTROL_PORT).toBe(5901);
  });

  it("desktop.control carries the flag and a bounded controller name", () => {
    expect(
      workItemSchema.safeParse({ kind: "desktop.control", controlled: true })
        .success,
    ).toBe(true);
    expect(
      workItemSchema.safeParse({
        kind: "desktop.control",
        controlled: true,
        controllerName: "Alex Kim",
      }).success,
    ).toBe(true);
    expect(
      workItemSchema.safeParse({
        kind: "desktop.control",
        controlled: false,
        controllerName: "x".repeat(MAX_DESKTOP_CONTROLLER_NAME_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(workItemSchema.safeParse({ kind: "desktop.control" }).success).toBe(
      false,
    );
  });

  it("the runner's desktop.control names the sandbox and nothing more", () => {
    const item = runnerWorkItemSchema.parse({
      kind: "desktop.control",
      sandboxId: "sb-1",
      controlled: true,
      controllerName: "Alex Kim",
    });
    expect(item).toEqual({
      kind: "desktop.control",
      sandboxId: "sb-1",
      controlled: true,
      controllerName: "Alex Kim",
    });
    expect(
      runnerWorkItemSchema.safeParse({
        kind: "desktop.control",
        controlled: true,
      }).success,
    ).toBe(false);
  });

  it("desktop.state and sandbox.desktop carry the viewable flag with the runner's stamped facts", () => {
    expect(
      supervisorMessageSchema.safeParse({
        kind: "desktop.state",
        viewable: true,
      }).success,
    ).toBe(true);
    expect(
      runnerEventSchema.safeParse({
        kind: "sandbox.desktop",
        sandboxId: "sb-1",
        containerRef: "c-1",
        viewable: true,
      }).success,
    ).toBe(true);
    // No stamped facts, no event: the control plane must never take the
    // supervisor's word for which sandbox is speaking.
    expect(
      runnerEventSchema.safeParse({ kind: "sandbox.desktop", viewable: true })
        .success,
    ).toBe(false);
  });

  it("the desktop steers are platform steers, distinct per direction", () => {
    const taken = desktopControlSteerId("t1", true);
    const released = desktopControlSteerId("t1", false);
    expect(taken).not.toBe(released);
    expect(isPlatformSteerId(taken)).toBe(true);
    expect(isPlatformSteerId(released)).toBe(true);
    expect(isPlatformSteerId("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(
      false,
    );
  });
});
