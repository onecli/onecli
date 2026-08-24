import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "@/lib/api/types";
import {
  homeDurabilityMessage,
  hostedAvailability,
  showsHostedSurface,
} from "./availability";

const instance = (runners?: InstanceInfo["runners"]): InstanceInfo => ({
  edition: "cloud",
  entitled: true,
  version: "test",
  ...(runners && { runners }),
});

describe("hostedAvailability", () => {
  it("is LOADING while the instance is unknown — never 'unavailable'", () => {
    // §3.13's loading-vs-unavailable rule. Rendering an empty state during the
    // first paint is a regression a user notices even though it self-corrects.
    expect(hostedAvailability(null)).toBe("loading");
  });

  it("is ABSENT when no runner has ever registered", () => {
    // Cloud's posture today. The whole hosted surface stays hidden, so the
    // dashboard is byte-identical to what paying users see now.
    expect(
      hostedAvailability(instance({ registered: false, online: false })),
    ).toBe("absent");
  });

  it("is ABSENT when the API answers without the field at all", () => {
    // An older API. Must read as "no hosted agents here", never as a crash
    // and never as a false "offline".
    expect(hostedAvailability(instance())).toBe("absent");
  });

  it("is OFFLINE when runners exist but none is reporting", () => {
    // The distinction that matters: agents EXIST, so hiding them would be a
    // lie. They just cannot run.
    expect(
      hostedAvailability(instance({ registered: true, online: false })),
    ).toBe("offline");
  });

  it("is READY when one is online", () => {
    expect(
      hostedAvailability(instance({ registered: true, online: true })),
    ).toBe("ready");
  });
});

describe("what each state permits", () => {
  it("hides the surface entirely while loading and when absent", () => {
    expect(showsHostedSurface("loading")).toBe(false);
    expect(showsHostedSurface("absent")).toBe(false);
  });

  it("SHOWS the surface when offline — the agents are real, just idle", () => {
    expect(showsHostedSurface("offline")).toBe(true);
    expect(showsHostedSurface("ready")).toBe(true);
  });
});

describe("homeDurabilityMessage", () => {
  it("states each declared class in agent words only — never a runner word", () => {
    const snapshot = homeDurabilityMessage(
      instance({ registered: true, online: true, homeDurability: "snapshot" }),
    );
    const resident = homeDurabilityMessage(
      instance({ registered: true, online: true, homeDurability: "resident" }),
    );
    expect(snapshot).toMatch(/archived to durable storage/);
    expect(resident).toMatch(/deployment's own disk/);
    for (const copy of [snapshot, resident]) {
      expect(copy).not.toMatch(/runner|sandbox|pvc|s3/i);
    }
  });

  it("renders NOTHING when the platform makes no claim — an older API or nobody online", () => {
    expect(homeDurabilityMessage(null)).toBeNull();
    expect(
      homeDurabilityMessage(instance({ registered: true, online: false })),
    ).toBeNull();
  });
});
