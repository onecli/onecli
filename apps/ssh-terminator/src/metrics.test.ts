import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-cloudwatch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@aws-sdk/client-cloudwatch")>();
  return {
    ...actual,
    CloudWatchClient: class {
      send = sendMock;
    },
  };
});

import { createTerminatorMetrics } from "./metrics";

interface SentCall {
  input: {
    Namespace: string;
    MetricData: Array<{
      MetricName: string;
      Value?: number;
      Values?: number[];
      Counts?: number[];
    }>;
  };
}

const sentData = (call: number): SentCall["input"] =>
  (sendMock.mock.calls[call]?.[0] as SentCall).input;

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

describe("terminator metrics (step 6 — drained, never per-event)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it("accumulates events into ONE publish per flush — an auth flood is one API call, not one per attempt", async () => {
    const metrics = createTerminatorMetrics("OneCLI/SandboxPlatform/dev");
    for (let i = 0; i < 500; i += 1) metrics.authFailure();
    metrics.sessionOpened();
    metrics.preauthRefusal();
    expect(sendMock).not.toHaveBeenCalled();

    metrics.flush(3);
    await flushAsync();
    expect(sendMock).toHaveBeenCalledTimes(1);
    const data = sentData(0);
    expect(data.Namespace).toBe("OneCLI/SandboxPlatform/dev");
    const byName = new Map(data.MetricData.map((d) => [d.MetricName, d]));
    expect(byName.get("SshSessionsLive")?.Value).toBe(3);
    expect(byName.get("SshAuthFailures")?.Value).toBe(500);
    expect(byName.get("SshSessionsOpened")?.Value).toBe(1);
    expect(byName.get("SshPreauthRefusals")?.Value).toBe(1);
    // Zero counters are omitted; the live gauge is the always-on heartbeat.
    expect(byName.has("SshSessionsClosed")).toBe(false);
  });

  it("publishes the live gauge every flush, zero included — the terminator-silent liveness series", async () => {
    const metrics = createTerminatorMetrics("ns");
    metrics.flush(0);
    await flushAsync();
    expect(sentData(0).MetricData).toEqual([
      expect.objectContaining({ MetricName: "SshSessionsLive", Value: 0 }),
    ]);
  });

  it("restores the counters when the publish fails — a flaky CloudWatch must not under-count failures", async () => {
    const metrics = createTerminatorMetrics("ns");
    sendMock.mockRejectedValueOnce(new Error("throttled"));
    metrics.authFailure();
    metrics.authFailure();
    metrics.flush(1);
    await flushAsync();

    metrics.flush(1);
    await flushAsync();
    const byName = new Map(
      sentData(1).MetricData.map((d) => [d.MetricName, d]),
    );
    expect(byName.get("SshAuthFailures")?.Value).toBe(2);
  });

  it("wake waits ride one Values/Counts array datum (raw values — percentiles keep working), bounded at 150", async () => {
    const metrics = createTerminatorMetrics("ns");
    for (let i = 0; i < 160; i += 1) metrics.wakeWaitSeconds(i);
    metrics.flush(0);
    await flushAsync();
    const datum = sentData(0).MetricData.find(
      (d) => d.MetricName === "SshWakeWaitSeconds",
    );
    expect(datum?.Values).toHaveLength(150);
    expect(datum?.Counts).toHaveLength(150);
    // Drop-oldest: the first 10 samples are gone.
    expect(datum?.Values?.[0]).toBe(10);
  });

  it("the pump flushes every 60s and once more on stop — the AWAITED rollout-drain flush", async () => {
    vi.useFakeTimers();
    try {
      const metrics = createTerminatorMetrics("ns");
      const stop = metrics.startPump(() => 7);
      vi.advanceTimersByTime(120_000);
      expect(sendMock).toHaveBeenCalledTimes(2);
      // stop() runs the FINAL flush and returns its settled promise — the
      // shutdown path awaits it so the drain's counters land pre-exit.
      metrics.sessionClosed();
      await stop();
      expect(sendMock).toHaveBeenCalledTimes(3);
      const byName = new Map(
        sentData(2).MetricData.map((d) => [d.MetricName, d]),
      );
      expect(byName.get("SshSessionsClosed")?.Value).toBe(1);
      vi.advanceTimersByTime(120_000);
      expect(sendMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
