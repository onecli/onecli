import { describe, expect, it } from "vitest";
import type { AgentEvent, RunnerEvent } from "@onecli/agent-protocol";
import { runnerEventSchema } from "@onecli/agent-protocol";
import {
  chunk,
  coalesce,
  createTurnEventCollector,
  MAX_BATCH_CHARS,
  MAX_EVENT_TEXT_CHARS,
  MAX_EVENTS_PER_POST,
} from "./turn-events";

/**
 * The delta law, runner side. Two properties decide whether this is safe:
 * merging must never disturb order, and a flush must never exceed the wire's
 * batch cap (an oversized post is rejected wholesale and swallowed as a warn,
 * which would lose a stretch of a turn silently).
 */

const text = (t: string): AgentEvent => ({ type: "text.delta", text: t });
const thinking = (t: string): AgentEvent => ({
  type: "thinking.delta",
  text: t,
});
const tool = (callId: string): AgentEvent => ({
  type: "tool.started",
  callId,
  name: "bash",
});

/** A scheduler the test fires by hand, so nothing here waits on wall time. */
const manualScheduler = () => {
  const pending = new Map<NodeJS.Timeout, () => void>();
  return {
    get size() {
      return pending.size;
    },
    fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const run of callbacks) run();
    },
    scheduler: {
      set: (fn: () => void) => {
        const handle = { unref: () => {} } as unknown as NodeJS.Timeout;
        pending.set(handle, fn);
        return handle;
      },
      clear: (handle: NodeJS.Timeout) => {
        pending.delete(handle);
      },
    },
  };
};

const collect = () => {
  const posts: RunnerEvent[] = [];
  const timers = manualScheduler();
  const collector = createTurnEventCollector({
    post: (event) => posts.push(event),
    scheduler: timers.scheduler,
  });
  return { posts, timers, collector };
};

/** The events of every post, flattened in the order they were sent. */
const flatEvents = (posts: RunnerEvent[]): AgentEvent[] =>
  posts.flatMap((post) => (post.kind === "turn.events" ? post.events : []));

describe("coalesce", () => {
  it("merges adjacent text deltas into one", () => {
    expect(coalesce([text("Hel"), text("lo "), text("world")])).toEqual([
      text("Hello world"),
    ]);
  });

  it("keeps text and thinking apart — they are different streams", () => {
    const merged = coalesce([text("a"), thinking("b"), text("c")]);
    expect(merged).toEqual([text("a"), thinking("b"), text("c")]);
  });

  it("never merges ACROSS a non-text event, so order survives", () => {
    const merged = coalesce([
      text("before "),
      text("call"),
      tool("c1"),
      text("after "),
      text("call"),
    ]);
    expect(merged).toEqual([
      text("before call"),
      tool("c1"),
      text("after call"),
    ]);
  });

  it("leaves a batch with nothing to merge exactly as it was", () => {
    const events = [
      tool("c1"),
      tool("c2"),
      { type: "turn.done" } as AgentEvent,
    ];
    expect(coalesce(events)).toEqual(events);
  });

  it("handles the empty batch", () => {
    expect(coalesce([])).toEqual([]);
  });
});

describe("chunk", () => {
  it("splits at the boundary and keeps order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one chunk when it fits", () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it("returns nothing for an empty list", () => {
    expect(chunk([], 5)).toEqual([]);
  });
});

describe("the collector", () => {
  it("holds text back rather than posting per token", () => {
    const { posts, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", text("a"));
    collector.add("sb-1", "cv-1", "t1", text("b"));
    expect(posts).toHaveLength(0);
  });

  it("posts one merged event when the timer fires", () => {
    const { posts, timers, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", text("Hel"));
    collector.add("sb-1", "cv-1", "t1", text("lo"));
    timers.fire();

    expect(posts).toEqual([
      {
        kind: "turn.events",
        sandboxId: "sb-1",
        conversationId: "cv-1",
        turnId: "t1",
        events: [text("Hello")],
      },
    ]);
  });

  it("flushes a terminal event IMMEDIATELY — a reader is waiting on it", () => {
    const { posts, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", text("done thinking"));
    collector.add("sb-1", "cv-1", "t1", { type: "turn.done" });

    expect(posts).toHaveLength(1);
    expect(flatEvents(posts)).toEqual([
      text("done thinking"),
      { type: "turn.done" },
    ]);
  });

  it("flushes an error event immediately too", () => {
    const { posts, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", { type: "error", message: "boom" });
    expect(flatEvents(posts)).toEqual([{ type: "error", message: "boom" }]);
  });

  it("cancels the pending timer once a turn has been flushed", () => {
    const { posts, timers, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", text("a"));
    expect(timers.size).toBe(1);
    collector.add("sb-1", "cv-1", "t1", { type: "turn.done" });
    expect(timers.size).toBe(0);

    // Firing a stale timer must not re-post the same events.
    timers.fire();
    expect(posts).toHaveLength(1);
  });

  it("buffers turns independently, each with its own conversation", () => {
    const { posts, timers, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", text("one"));
    collector.add("sb-1", "cv-2", "t2", text("two"));
    timers.fire();

    expect(posts).toHaveLength(2);
    expect(posts).toContainEqual({
      kind: "turn.events",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t1",
      events: [text("one")],
    });
    expect(posts).toContainEqual({
      kind: "turn.events",
      sandboxId: "sb-1",
      conversationId: "cv-2",
      turnId: "t2",
      events: [text("two")],
    });
  });

  it("flushing one turn leaves the others buffered", () => {
    const { posts, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", text("one"));
    collector.add("sb-1", "cv-2", "t2", text("two"));
    collector.flush("t1");

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ turnId: "t1" });
  });

  it("flushing an unknown turn is a no-op, not a crash", () => {
    const { posts, collector } = collect();
    collector.flush("never-existed");
    expect(posts).toHaveLength(0);
  });

  it("flushing an empty buffer posts nothing", () => {
    const { posts, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", text("a"));
    collector.flush("t1");
    collector.flush("t1");
    expect(posts).toHaveLength(1);
  });

  it("flushAll drains every turn and clears every timer", () => {
    const { posts, timers, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", text("one"));
    collector.add("sb-1", "cv-2", "t2", text("two"));
    collector.flushAll();

    expect(posts).toHaveLength(2);
    expect(timers.size).toBe(0);
  });
});

describe("the wire's batch cap is never exceeded", () => {
  /** Events that coalescing cannot collapse — the worst case for a flush. */
  const uncollapsible = (count: number): AgentEvent[] =>
    Array.from({ length: count }, (_, i) => tool(`call-${i}`));

  it("chunks an oversized flush into posts of at most the cap", () => {
    const { posts, collector } = collect();
    for (const event of uncollapsible(250))
      collector.add("sb-1", "cv-1", "t1", event);
    collector.flush("t1");

    expect(posts).toHaveLength(3);
    for (const post of posts) {
      expect(
        post.kind === "turn.events" && post.events.length,
      ).toBeLessThanOrEqual(MAX_EVENTS_PER_POST);
    }
    // Nothing lost and nothing reordered across the split.
    expect(flatEvents(posts)).toEqual(uncollapsible(250));
  });

  it("every post it produces actually validates against the wire schema", () => {
    // The cap is the schema's, so this is the assertion that matters: an
    // oversized post would 400 at the control plane and be swallowed as a warn.
    const { posts, collector } = collect();
    for (const event of uncollapsible(250))
      collector.add("sb-1", "cv-1", "t1", event);
    collector.add("sb-1", "cv-1", "t1", { type: "turn.done" });

    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) {
      expect(runnerEventSchema.safeParse(post).success).toBe(true);
    }
  });

  it("a long stream of text needs no chunking at all — it merges to one", () => {
    const { posts, collector } = collect();
    for (let i = 0; i < 5_000; i += 1)
      collector.add("sb-1", "cv-1", "t1", text("x"));
    collector.flush("t1");

    expect(posts).toHaveLength(1);
    expect(flatEvents(posts)).toEqual([text("x".repeat(5_000))]);
  });
});

describe("size is bounded, not just count", () => {
  // The count cap alone is not a bound: an event's strings carry model output
  // — a tool.finished holds whatever the agent just read — and they land in a
  // database column. This is the arm that keeps one `cat` of a big file from
  // becoming a multi-megabyte row.

  it("TRUNCATES a huge tool output instead of forwarding it whole", () => {
    const { posts, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", {
      type: "tool.finished",
      callId: "c1",
      name: "cat",
      output: "A".repeat(5_000_000),
    });
    collector.flush("t1");

    const [event] = flatEvents(posts);
    expect(event?.type).toBe("tool.finished");
    const output = event?.type === "tool.finished" ? event.output : "";
    expect(output.length).toBeLessThan(MAX_EVENT_TEXT_CHARS + 100);
    // Truncated visibly — a reader must not mistake it for the whole output.
    expect(output).toContain("truncated");
    expect(output.startsWith("A".repeat(1_000))).toBe(true);
  });

  it("truncates every string an event carries, not only the obvious one", () => {
    const { posts, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", {
      type: "error",
      message: "M".repeat(200_000),
      code: "C".repeat(200_000),
    });
    collector.flush("t1");

    const [event] = flatEvents(posts);
    if (event?.type !== "error") throw new Error("expected an error event");
    expect(event.message.length).toBeLessThan(MAX_EVENT_TEXT_CHARS + 100);
    expect(event.code?.length).toBeLessThan(MAX_EVENT_TEXT_CHARS + 100);
  });

  it("STRIPS a NUL byte, which PostgreSQL will not store", () => {
    // An agent that reads a binary file emits a valid event the database
    // refuses. Rejecting it would take the whole batch down and lose that
    // stretch of the turn, so the byte goes and the text stays.
    const { posts, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", {
      type: "tool.finished",
      callId: "c1",
      name: "cat",
      output: `head${String.fromCharCode(0)}tail`,
    });
    collector.flush("t1");

    const [event] = flatEvents(posts);
    if (event?.type !== "tool.finished")
      throw new Error("expected a tool event");
    expect(event.output).toBe("headtail");
    expect(event.output.includes(String.fromCharCode(0))).toBe(false);
  });

  it("leaves ordinary text completely alone", () => {
    const { posts, collector } = collect();
    collector.add("sb-1", "cv-1", "t1", text("a normal answer"));
    collector.flush("t1");
    expect(flatEvents(posts)).toEqual([text("a normal answer")]);
  });

  it("splits a batch of large events so no post exceeds the size cap", () => {
    const { posts, collector } = collect();
    // 40 events at ~16 KB each ≈ 640 KB — over the 256 KB batch target, and
    // under the 100-event count cap, so ONLY the size split can catch it.
    for (let i = 0; i < 40; i += 1) {
      collector.add("sb-1", "cv-1", "t1", {
        type: "tool.finished",
        callId: `c${i}`,
        name: "cat",
        output: "B".repeat(MAX_EVENT_TEXT_CHARS),
      });
    }
    collector.flush("t1");

    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) {
      if (post.kind !== "turn.events") continue;
      expect(JSON.stringify(post.events).length).toBeLessThanOrEqual(
        MAX_BATCH_CHARS,
      );
      // And still legal on the wire, which is the assertion that matters.
      expect(runnerEventSchema.safeParse(post).success).toBe(true);
    }
    // Nothing lost in the split.
    expect(flatEvents(posts)).toHaveLength(40);
  });

  it("every post it can produce survives the wire's SIZE refine", () => {
    const { posts, collector } = collect();
    for (let i = 0; i < 100; i += 1) {
      collector.add("sb-1", "cv-1", "t1", {
        type: "tool.finished",
        callId: `c${i}`,
        name: "n",
        output: "C".repeat(1_000_000),
      });
    }
    collector.flush("t1");

    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      expect(runnerEventSchema.safeParse(post).success).toBe(true);
    }
  });

  it("the wire REFUSES an oversized batch the runner did not shrink", () => {
    // The control plane's own guard, independent of the runner behaving.
    const oversized = {
      kind: "turn.events",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t1",
      events: [
        {
          type: "tool.finished",
          callId: "c",
          name: "n",
          output: "X".repeat(2_000_000),
        },
      ],
    };
    expect(runnerEventSchema.safeParse(oversized).success).toBe(false);
  });
});
