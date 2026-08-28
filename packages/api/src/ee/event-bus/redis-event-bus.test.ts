import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishedEvent } from "../../services/event-bus";
import { createRedisEventBus, type RedisEventBusDeps } from "./redis-event-bus";

/**
 * The cloud fan-out bus, exercised against a fake ioredis pair — no real
 * Redis. What matters: a publish goes onto the right channel; an inbound
 * message fans out to that conversation's local listeners and no others;
 * channel subscribe/unsubscribe is REF-COUNTED (one per conversation whatever
 * the listener count) so a pod carries only the channels it tails; and a
 * failing publisher never throws onto the runner's critical path.
 */

const event = (seq: number): PublishedEvent => ({
  seq,
  turnId: "t-1",
  type: "text.delta",
  event: { type: "text.delta", text: `chunk-${seq}` },
});

type MessageHandler = (channel: string, payload: string) => void;

const fakeRedis = () => {
  const published: Array<{ channel: string; payload: string }> = [];
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  let onMessage: MessageHandler | undefined;

  const deps: RedisEventBusDeps = {
    publisher: {
      publish: vi.fn(async (channel: string, payload: string) => {
        published.push({ channel, payload });
        return 1;
      }),
    } as unknown as RedisEventBusDeps["publisher"],
    subscriber: {
      subscribe: vi.fn(async (channel: string) => {
        subscribed.push(channel);
        return 1;
      }),
      unsubscribe: vi.fn(async (channel: string) => {
        unsubscribed.push(channel);
        return 0;
      }),
      on: vi.fn((eventName: string, handler: MessageHandler) => {
        if (eventName === "message") onMessage = handler;
        return undefined as never;
      }),
    } as unknown as RedisEventBusDeps["subscriber"],
  };

  return {
    deps,
    published,
    subscribed,
    unsubscribed,
    /** Simulate Redis delivering a message on a channel. */
    deliver: (channel: string, events: PublishedEvent[]) =>
      onMessage?.(channel, JSON.stringify(events)),
    deliverRaw: (channel: string, payload: string) =>
      onMessage?.(channel, payload),
  };
};

let redis: ReturnType<typeof fakeRedis>;
beforeEach(() => {
  redis = fakeRedis();
});

describe("publish", () => {
  it("PUBLISHes the batch as JSON on the conversation's api: channel", () => {
    const bus = createRedisEventBus(redis.deps);
    bus.publish("cv-1", [event(1), event(2)]);
    expect(redis.published).toEqual([
      {
        channel: "api:evt:cv-1",
        payload: JSON.stringify([event(1), event(2)]),
      },
    ]);
  });

  it("ignores an empty batch — no channel traffic", () => {
    const bus = createRedisEventBus(redis.deps);
    bus.publish("cv-1", []);
    expect(redis.published).toEqual([]);
  });

  it("NEVER throws when the publisher rejects — the runner's critical path is safe", () => {
    const deps = {
      ...redis.deps,
      publisher: {
        publish: vi.fn(() => Promise.reject(new Error("redis down"))),
      } as unknown as RedisEventBusDeps["publisher"],
    };
    const bus = createRedisEventBus(deps);
    expect(() => bus.publish("cv-1", [event(1)])).not.toThrow();
  });

  it("NEVER throws when the publisher throws synchronously", () => {
    const deps = {
      ...redis.deps,
      publisher: {
        publish: vi.fn(() => {
          throw new Error("boom");
        }),
      } as unknown as RedisEventBusDeps["publisher"],
    };
    const bus = createRedisEventBus(deps);
    expect(() => bus.publish("cv-1", [event(1)])).not.toThrow();
  });
});

describe("inbound message fan-out", () => {
  it("delivers a channel message to that conversation's local listeners only", () => {
    const bus = createRedisEventBus(redis.deps);
    const mine = vi.fn();
    const theirs = vi.fn();
    bus.subscribe("cv-1", mine);
    bus.subscribe("cv-2", theirs);

    redis.deliver("api:evt:cv-1", [event(1)]);

    expect(mine).toHaveBeenCalledWith([event(1)]);
    expect(theirs).not.toHaveBeenCalled();
  });

  it("drops an unparseable payload without throwing or delivering", () => {
    const bus = createRedisEventBus(redis.deps);
    const listener = vi.fn();
    bus.subscribe("cv-1", listener);
    expect(() => redis.deliverRaw("api:evt:cv-1", "{not json")).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores a message on a foreign channel prefix", () => {
    const bus = createRedisEventBus(redis.deps);
    const listener = vi.fn();
    bus.subscribe("cv-1", listener);
    redis.deliver("other:cv-1", [event(1)]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("ref-counted channel subscription", () => {
  it("SUBSCRIBEs once on the first local listener, UNSUBSCRIBEs on the last", () => {
    const bus = createRedisEventBus(redis.deps);
    const releaseA = bus.subscribe("cv-1", vi.fn()).release;
    const releaseB = bus.subscribe("cv-1", vi.fn()).release;

    // One channel subscribe for the conversation, whatever the listener count.
    expect(redis.subscribed).toEqual(["api:evt:cv-1"]);
    expect(redis.unsubscribed).toEqual([]);

    releaseA();
    // Still a local tailer → channel stays.
    expect(redis.unsubscribed).toEqual([]);

    releaseB();
    // Last tailer gone → drop the channel on this pod.
    expect(redis.unsubscribed).toEqual(["api:evt:cv-1"]);
  });

  it("re-SUBSCRIBEs after a conversation went empty and came back", () => {
    const bus = createRedisEventBus(redis.deps);
    bus.subscribe("cv-1", vi.fn()).release();
    bus.subscribe("cv-1", vi.fn());
    expect(redis.subscribed).toEqual(["api:evt:cv-1", "api:evt:cv-1"]);
  });

  it("a double release cannot double-unsubscribe", () => {
    const bus = createRedisEventBus(redis.deps);
    const release = bus.subscribe("cv-1", vi.fn()).release;
    release();
    release();
    expect(redis.unsubscribed).toEqual(["api:evt:cv-1"]);
  });
});

describe("ready ordering (the subscribe-before-snapshot guarantee)", () => {
  it("ready resolves only after the SUBSCRIBE ack — a caller can await it before a history snapshot", async () => {
    let ackSubscribe: (() => void) | undefined;
    const deps = {
      ...redis.deps,
      subscriber: {
        subscribe: vi.fn(
          () =>
            new Promise<number>((resolve) => (ackSubscribe = () => resolve(1))),
        ),
        unsubscribe: vi.fn(async () => 0),
        on: vi.fn(),
      } as unknown as RedisEventBusDeps["subscriber"],
    };
    const bus = createRedisEventBus(deps);
    const { ready } = bus.subscribe("cv-1", vi.fn());

    let resolved = false;
    void ready.then(() => (resolved = true));
    await Promise.resolve();
    // Not ready until Redis acks the SUBSCRIBE.
    expect(resolved).toBe(false);
    ackSubscribe?.();
    await ready;
    expect(resolved).toBe(true);
  });

  it("a second local subscriber on an already-subscribed channel is ready immediately", async () => {
    const bus = createRedisEventBus(redis.deps);
    bus.subscribe("cv-1", vi.fn());
    const { ready } = bus.subscribe("cv-1", vi.fn());
    await expect(ready).resolves.toBeUndefined();
  });

  it("a subscriber arriving during an UN-ACKED subscribe shares the ack — in-flight is not acked", async () => {
    let ackSubscribe: (() => void) | undefined;
    const deps = {
      ...redis.deps,
      subscriber: {
        subscribe: vi.fn(
          () =>
            new Promise<number>((resolve) => (ackSubscribe = () => resolve(1))),
        ),
        unsubscribe: vi.fn(async () => 0),
        on: vi.fn(),
      } as unknown as RedisEventBusDeps["subscriber"],
    };
    const bus = createRedisEventBus(deps);
    bus.subscribe("cv-1", vi.fn());
    // Second tab, same conversation, same pod, SUBSCRIBE still in flight:
    // its snapshot must wait for the same ack or an event committed on
    // another pod inside the round-trip lands in neither snapshot nor tail.
    const { ready } = bus.subscribe("cv-1", vi.fn());

    let resolved = false;
    void ready.then(() => (resolved = true));
    await Promise.resolve();
    expect(resolved).toBe(false);
    ackSubscribe?.();
    await ready;
    expect(resolved).toBe(true);
  });

  it("a REJECTED subscribe rejects ready — a deaf channel must close its streams, not heartbeat forever", async () => {
    const deps = {
      ...redis.deps,
      subscriber: {
        subscribe: vi.fn(() => Promise.reject(new Error("redis down"))),
        unsubscribe: vi.fn(async () => 0),
        on: vi.fn(),
      } as unknown as RedisEventBusDeps["subscriber"],
    };
    const bus = createRedisEventBus(deps);
    await expect(bus.subscribe("cv-1", vi.fn()).ready).rejects.toThrow(
      "redis down",
    );
  });

  it("the NEXT subscriber after a rejection re-issues the SUBSCRIBE — no poisoned channel", async () => {
    let calls = 0;
    const subscribe = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("blip"))
        : Promise.resolve(1);
    });
    const deps = {
      ...redis.deps,
      subscriber: {
        subscribe,
        unsubscribe: vi.fn(async () => 0),
        on: vi.fn(),
      } as unknown as RedisEventBusDeps["subscriber"],
    };
    const bus = createRedisEventBus(deps);
    await expect(bus.subscribe("cv-1", vi.fn()).ready).rejects.toThrow("blip");
    // The failed attempt is forgotten even though the first listener is
    // still registered — a live local count must not gate the retry.
    await expect(bus.subscribe("cv-1", vi.fn()).ready).resolves.toBeUndefined();
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
});
