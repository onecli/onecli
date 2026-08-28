import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createJcodeWakeFeed,
  MAX_PENDING_WAKES,
  WAKE_REPLAY_MS,
} from "./jcode-wake";

const deliverStalled = (
  feed: ReturnType<typeof createJcodeWakeFeed>,
  overrides: Record<string, string> = {},
) =>
  feed.deliver({
    reason: "background_task_stalled",
    notification: "task `probe` went quiet",
    conversationId: "cv-1",
    ...overrides,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("the wake feed", () => {
  it("mirrors a wake as ONE born-terminal task with wake intent, context, and the notification as output", async () => {
    const feed = createJcodeWakeFeed();
    deliverStalled(feed);

    const tasks = await feed.poll();
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.ref).toMatch(/^wake:[0-9a-f-]{36}$/);
    expect(task.ref.length).toBeLessThanOrEqual(100);
    expect(task.status).toBe("exited");
    expect(task.exitCode).toBeUndefined();
    expect(task.wantsWake).toBe(true);
    expect(task.context).toEqual({ conversationId: "cv-1" });
    expect(task.outputDelta).toContain("went quiet");
    expect(task.wakePrompt).toContain("stalled");
  });

  it("REPLAYS the same ref on every poll inside the window — a failing observer pass cannot eat the wake", async () => {
    const feed = createJcodeWakeFeed();
    deliverStalled(feed);

    const first = await feed.poll();
    const second = await feed.poll();
    expect(second).toHaveLength(1);
    expect(second[0]?.ref).toBe(first[0]?.ref);
  });

  it("evicts an entry after the replay window", async () => {
    vi.useFakeTimers();
    const feed = createJcodeWakeFeed();
    deliverStalled(feed);
    expect(await feed.poll()).toHaveLength(1);

    vi.advanceTimersByTime(WAKE_REPLAY_MS + 1_000);
    expect(await feed.poll()).toHaveLength(0);
  });

  it("drops background_task_completed — the registry mirror owns that wake end to end", async () => {
    const feed = createJcodeWakeFeed();
    deliverStalled(feed, { reason: "background_task_completed" });
    expect(await feed.poll()).toHaveLength(0);
  });

  it("forwards an unknown reason generically — never silent", async () => {
    const feed = createJcodeWakeFeed();
    deliverStalled(feed, { reason: "some_future_reason" });
    const tasks = await feed.poll();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.name).toBe("background wake");
  });

  it("maps the fan-out and message reasons to honest labels and prompts", async () => {
    const feed = createJcodeWakeFeed();
    deliverStalled(feed, { reason: "swarm_await_completed" });
    deliverStalled(feed, { reason: "communication_delivery" });

    const byName = new Map((await feed.poll()).map((t) => [t.name, t]));
    expect(byName.get("helpers finished")?.wakePrompt).toContain(
      "Helper agents",
    );
    expect(byName.get("message from another agent")?.wakePrompt).toContain(
      "Another agent",
    );
  });

  it("bounds the pending set FIFO — a wake storm cannot grow it without limit", async () => {
    const feed = createJcodeWakeFeed();
    for (let i = 0; i < MAX_PENDING_WAKES + 5; i += 1) {
      deliverStalled(feed, { conversationId: `cv-${i}` });
    }
    const tasks = await feed.poll();
    expect(tasks).toHaveLength(MAX_PENDING_WAKES);
    // FIFO: the oldest five were evicted.
    expect(tasks[0]?.context?.conversationId).toBe("cv-5");
  });

  it("clamps an oversized notification instead of shipping it whole", async () => {
    const feed = createJcodeWakeFeed();
    deliverStalled(feed, { notification: "x".repeat(10_000) });
    const tasks = await feed.poll();
    expect(tasks[0]?.outputDelta?.length).toBeLessThanOrEqual(2_000);
  });
});
