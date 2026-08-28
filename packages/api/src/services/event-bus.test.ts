import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventBus, PublishedEvent } from "./event-bus";
import { createInProcessEventBus } from "./event-bus";

// The in-process fan-out emitter — the onprem default AND the local half the
// cloud Redis bus reuses. Its laws matter more than they look: a leaked
// listener outlives the browser tab that made it, and a throwing subscriber
// sits on the runner's critical path.

const event = (seq: number): PublishedEvent => ({
  seq,
  turnId: "t-1",
  type: "text.delta",
  event: { type: "text.delta", text: `chunk-${seq}` },
});

// A fresh bus per test — the emitter is now an instance, not module state.
let bus: EventBus;
const publish = (cv: string, events: PublishedEvent[]) =>
  bus.publish(cv, events);
const subscribe = (cv: string, listener: (e: PublishedEvent[]) => void) =>
  bus.subscribe(cv, listener).release;
const subscriberCount = (cv: string) => bus.subscriberCount(cv);
const trackedConversationCount = () => bus.trackedConversationCount();

beforeEach(() => {
  bus = createInProcessEventBus();
  // A fresh bus has no listeners; this asserts the instance starts clean.
  expect(subscriberCount("cv-1")).toBe(0);
});

describe("publish/subscribe", () => {
  it("delivers to a subscriber of that conversation", () => {
    const seen: PublishedEvent[][] = [];
    const release = subscribe("cv-1", (events) => seen.push(events));

    publish("cv-1", [event(1), event(2)]);

    expect(seen).toEqual([[event(1), event(2)]]);
    release();
  });

  it("does NOT leak across conversations", () => {
    const mine = vi.fn();
    const theirs = vi.fn();
    const releaseMine = subscribe("cv-1", mine);
    const releaseTheirs = subscribe("cv-2", theirs);

    publish("cv-1", [event(1)]);

    expect(mine).toHaveBeenCalledOnce();
    expect(theirs).not.toHaveBeenCalled();
    releaseMine();
    releaseTheirs();
  });

  it("delivers to every subscriber of one conversation", () => {
    const a = vi.fn();
    const b = vi.fn();
    const releaseA = subscribe("cv-1", a);
    const releaseB = subscribe("cv-1", b);

    publish("cv-1", [event(1)]);

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    releaseA();
    releaseB();
  });

  it("publishing with no subscribers is a no-op, not an error", () => {
    expect(() => publish("cv-nobody", [event(1)])).not.toThrow();
  });

  it("ignores an empty batch", () => {
    const listener = vi.fn();
    const release = subscribe("cv-1", listener);
    publish("cv-1", []);
    expect(listener).not.toHaveBeenCalled();
    release();
  });
});

describe("isolation of a bad subscriber", () => {
  it("a THROWING listener does not stop the others", () => {
    // The publisher is on the runner's critical path — one broken tail must
    // not cost another subscriber its events.
    const good = vi.fn();
    const releaseBad = subscribe("cv-1", () => {
      throw new Error("subscriber exploded");
    });
    const releaseGood = subscribe("cv-1", good);

    expect(() => publish("cv-1", [event(1)])).not.toThrow();
    expect(good).toHaveBeenCalledOnce();

    releaseBad();
    releaseGood();
  });

  it("a listener that unsubscribes mid-publish does not corrupt the walk", () => {
    const later = vi.fn();
    let releaseSelf: () => void = () => {};
    releaseSelf = subscribe("cv-1", () => releaseSelf());
    const releaseLater = subscribe("cv-1", later);

    expect(() => publish("cv-1", [event(1)])).not.toThrow();
    expect(later).toHaveBeenCalledOnce();
    releaseLater();
  });
});

describe("release", () => {
  it("stops delivery", () => {
    const listener = vi.fn();
    const release = subscribe("cv-1", listener);
    release();

    publish("cv-1", [event(1)]);

    expect(listener).not.toHaveBeenCalled();
  });

  it("is idempotent — a double release cannot drop someone else", () => {
    const other = vi.fn();
    const release = subscribe("cv-1", vi.fn());
    const releaseOther = subscribe("cv-1", other);

    release();
    release();

    publish("cv-1", [event(1)]);
    expect(other).toHaveBeenCalledOnce();
    releaseOther();
  });

  it("drops the conversation entry entirely when the last listener leaves", () => {
    // Otherwise the map grows one entry per conversation ever streamed.
    const before = trackedConversationCount();
    const release = subscribe("cv-leak-check", vi.fn());
    expect(subscriberCount("cv-leak-check")).toBe(1);

    release();

    expect(subscriberCount("cv-leak-check")).toBe(0);
    expect(trackedConversationCount()).toBe(before);
  });
});
