import {
  CloudWatchClient,
  type MetricDatum,
  PutMetricDataCommand,
  StandardUnit,
} from "@aws-sdk/client-cloudwatch";
import { logger } from "./logger";

const log = logger.child({ component: "terminator-metrics" });

/**
 * The terminator's session metrics, in the per-env platform namespace.
 * DRAINED, never per-event (changed at step 6): the SSH listener is the
 * platform's only internet-facing unauthenticated port, and a per-event
 * PutMetricData turns an auth-failure flood into a metered-API amplification
 * that throttles away exactly the datapoints the ssh-auth-failures alarm
 * needs. Counters accumulate in-process and one flush per pump tick
 * publishes everything; a failed publish restores the counters (parkd's
 * drain law — a flaky CloudWatch must not under-count failures exactly when
 * observability matters). Wake-wait samples ride one Values/Counts array
 * datum (raw values, so percentile stats keep working); sample loss on a
 * failed publish is accepted — latency telemetry, never correctness state.
 */

/** PutMetricData caps Values at 150 entries per datum; drop-oldest past it. */
const WAKE_WAIT_BUFFER_CAP = 150;

export interface TerminatorMetrics {
  sessionOpened(): void;
  sessionClosed(): void;
  authFailure(): void;
  /** Pre-auth admission refusals (global cap / per-IP cap / token bucket). */
  preauthRefusal(): void;
  wakeWaitSeconds(seconds: number): void;
  /**
   * Drain-and-publish one PutMetricData call. `liveSessions` is sampled at
   * flush time and published every tick, zero included — the dimensionless
   * series doubles as the terminator's liveness heartbeat (prod-only
   * terminator-silent alarm). The pump's ticks fire-and-forget the returned
   * promise; the shutdown path AWAITS it so the drain's final counters land
   * before the process exits. Always resolves (a failed publish restores the
   * counters and logs — it never throws).
   */
  flush(liveSessions: number): Promise<void>;
  /**
   * One flush per minute (parkd's cadence — the terminator-silent liveness
   * alarm reads the SshSessionsLive series this keeps continuous). The
   * returned stop clears the timer and runs (and returns) the FINAL flush,
   * so a rollout's drain-window counters are never lost with the process —
   * the shutdown path awaits it after server.drain().
   */
  startPump(liveSessions: () => number): () => Promise<void>;
}

export const createTerminatorMetrics = (
  namespace: string,
): TerminatorMetrics => {
  const cloudwatch = new CloudWatchClient({});
  let opened = 0;
  let closed = 0;
  let authFailures = 0;
  let preauthRefusals = 0;
  let wakeWaits: number[] = [];

  const metrics: TerminatorMetrics = {
    startPump: (liveSessions) => {
      const timer = setInterval(() => {
        void metrics.flush(liveSessions());
      }, 60_000);
      timer.unref();
      return () => {
        clearInterval(timer);
        return metrics.flush(liveSessions());
      };
    },
    sessionOpened: () => {
      opened += 1;
    },
    sessionClosed: () => {
      closed += 1;
    },
    authFailure: () => {
      authFailures += 1;
    },
    preauthRefusal: () => {
      preauthRefusals += 1;
    },
    wakeWaitSeconds: (seconds) => {
      if (wakeWaits.length >= WAKE_WAIT_BUFFER_CAP) wakeWaits.shift();
      wakeWaits.push(seconds);
    },
    flush: (liveSessions) => {
      const drained = { opened, closed, authFailures, preauthRefusals };
      const waits = wakeWaits;
      opened = 0;
      closed = 0;
      authFailures = 0;
      preauthRefusals = 0;
      wakeWaits = [];

      const counter = (name: string, value: number): MetricDatum[] =>
        value > 0
          ? [{ MetricName: name, Value: value, Unit: StandardUnit.Count }]
          : [];
      const data: MetricDatum[] = [
        {
          // Per-REPLICA gauge (the admission cap in limits.ts is
          // per-process): alarms read Maximum; a fleet total needs the
          // SEARCH-sum form, never a plain Sum of the 60s samples.
          MetricName: "SshSessionsLive",
          Value: liveSessions,
          Unit: StandardUnit.Count,
        },
        ...counter("SshSessionsOpened", drained.opened),
        ...counter("SshSessionsClosed", drained.closed),
        ...counter("SshAuthFailures", drained.authFailures),
        ...counter("SshPreauthRefusals", drained.preauthRefusals),
        ...(waits.length > 0
          ? [
              {
                MetricName: "SshWakeWaitSeconds",
                Values: waits,
                Counts: waits.map(() => 1),
                Unit: StandardUnit.Seconds,
              },
            ]
          : []),
      ];
      return cloudwatch
        .send(
          new PutMetricDataCommand({ Namespace: namespace, MetricData: data }),
        )
        .then(() => undefined)
        .catch((error: unknown) => {
          // Restore the counters so a flaky CloudWatch cannot under-count;
          // wake-wait samples are accepted loss (telemetry, bounded buffer).
          opened += drained.opened;
          closed += drained.closed;
          authFailures += drained.authFailures;
          preauthRefusals += drained.preauthRefusals;
          log.warn({ err: error }, "metrics publish failed");
        });
    },
  };
  return metrics;
};

/** Test twin — records instead of publishing. */
export interface FakeTerminatorMetrics extends TerminatorMetrics {
  counts: {
    opened: number;
    closed: number;
    authFailures: number;
    preauthRefusals: number;
  };
  wakeWaits: number[];
  flushes: number[];
}

export const createFakeTerminatorMetrics = (): FakeTerminatorMetrics => {
  const counts = { opened: 0, closed: 0, authFailures: 0, preauthRefusals: 0 };
  const wakeWaits: number[] = [];
  const flushes: number[] = [];
  return {
    counts,
    wakeWaits,
    flushes,
    sessionOpened: () => {
      counts.opened += 1;
    },
    sessionClosed: () => {
      counts.closed += 1;
    },
    authFailure: () => {
      counts.authFailures += 1;
    },
    preauthRefusal: () => {
      counts.preauthRefusals += 1;
    },
    wakeWaitSeconds: (seconds) => {
      wakeWaits.push(seconds);
    },
    flush: (liveSessions) => {
      flushes.push(liveSessions);
      return Promise.resolve();
    },
    startPump: () => () => Promise.resolve(),
  };
};
