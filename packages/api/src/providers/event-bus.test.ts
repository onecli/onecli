import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventBus, PublishedEvent } from "../services/event-bus";

/**
 * The provider slot: onprem (and any deployment before injection) resolves a
 * working in-process emitter; a test/host override swaps it; null resets.
 * The cloud injection path itself lives in edition-defaults and is covered by
 * the Redis bus's own suite — here we prove the seam a onprem caller sees.
 *
 * Pinned to onprem: these assert the onprem DEFAULT (the memoized in-process
 * emitter). CI runs the api suite under NEXT_PUBLIC_EDITION=cloud, where the
 * slot is fail-loud without injection — so force onprem before the provider
 * (and its `IS_CLOUD`) evaluate, exactly as instance.test.ts does. Injecting
 * an override instead would make the singleton-memoization guard below
 * vacuous (get() would trivially return the same override).
 */
vi.hoisted(() => {
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const { getEventBus, initEventBus } = await import("./event-bus");

afterEach(() => initEventBus(null));

const event = (seq: number): PublishedEvent => ({
  seq,
  turnId: "t-1",
  type: "text.delta",
  event: { type: "text.delta", text: `chunk-${seq}` },
});

describe("event-bus provider", () => {
  it("defaults to a functional in-process emitter (the onprem path)", () => {
    const seen: PublishedEvent[][] = [];
    const release = getEventBus().subscribe("cv-1", (e) =>
      seen.push(e),
    ).release;
    getEventBus().publish("cv-1", [event(1)]);
    expect(seen).toEqual([[event(1)]]);
    release();
  });

  it("resolves the SAME bus across separate get() calls — subscribe and publish must share one Map", () => {
    // The load-bearing guard: the slot resolves a thunk on every get(), so a
    // fresh-per-call default would put the SSE subscribe and the runner
    // publish on different in-process buses and deliver to no one. Subscribe
    // on one resolution, publish on another — the listener must still fire.
    const seen = vi.fn();
    const release = getEventBus().subscribe("cv-1", seen).release;
    getEventBus().publish("cv-1", [event(1)]);
    expect(seen).toHaveBeenCalledOnce();
    expect(getEventBus()).toBe(getEventBus());
    release();
  });

  it("an injected bus overrides the default; null resets", () => {
    const calls: string[] = [];
    const fake: EventBus = {
      publish: (cv) => calls.push(`publish:${cv}`),
      subscribe: () => ({ release: () => undefined, ready: Promise.resolve() }),
      subscriberCount: () => 0,
      trackedConversationCount: () => 0,
    };
    initEventBus(fake);
    getEventBus().publish("cv-9", [event(1)]);
    expect(calls).toEqual(["publish:cv-9"]);

    initEventBus(null);
    // Back to the in-process default: the fake sees nothing more.
    getEventBus().publish("cv-9", [event(2)]);
    expect(calls).toEqual(["publish:cv-9"]);
  });
});
