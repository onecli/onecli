import { TURN_FAILURE_CODES, type RunnerEvent } from "@onecli/agent-protocol";
import { isProvablyUnapplied } from "./control-plane";

/**
 * THE REPORT CHAIN: every supervisor report goes to the control plane one at
 * a time, in the order it was made (`seq` is assigned at arrival, so order on
 * the wire IS transcript order), bounded so an untrusted sandbox cannot grow
 * it without limit. A failed post is logged and dropped: re-posting
 * transcript events could duplicate rows.
 *
 * One exception: a turn's end (`turn.finished`) whose post PROVABLY never
 * applied (`isProvablyUnapplied`: the request never left, or the server
 * answered that it took none of it) is re-sent on a jittered backoff until it
 * lands. Losing it strands a turn that already finished, and the active-turn
 * index then holds the whole conversation behind it. Only the provable case:
 * a post that may have landed is never repeated, so no close is ever applied
 * twice. The control plane's stall sweep is the backstop for those, and for
 * a re-send that runs out of budget.
 *
 * Never a death report (the harness or its channel died): the sandbox's own
 * `stopped` report owns that recovery, and the control plane may already
 * have revived the turn onto a fresh boot, whose retry a late death report
 * would then fail.
 *
 * Re-sends go back through the chain, so a turn's end never overtakes the
 * transcript events queued before it.
 */

/** Queue depth past which reports are dropped rather than accumulated. */
const MAX_QUEUED_REPORTS = 200;
/** Extra room past the cap for turn ends: one small event per turn. */
const TERMINAL_RESERVE = 64;
/** Turn ends awaiting a re-send, across the process and per sandbox: the
 * sandbox is untrusted and must not crowd out other tenants' turn ends. */
const MAX_PENDING_RESENDS = 64;
const MAX_PENDING_RESENDS_PER_SANDBOX = 8;
/** Re-sends of one turn end before it is left to the stall sweep: at most
 * about an hour of backoff, past any restart or deploy. */
const MAX_RESENDS = 64;
/** Full-jitter backoff (a uniform draw under a doubling ceiling), so runner
 * copies recovering from the same outage do not re-send in lockstep. */
const RESEND_BASE_MS = 2_000;
const RESEND_CAP_MS = 60_000;

const resendDelayMs = (attempt: number): number =>
  Math.random() * Math.min(RESEND_CAP_MS, RESEND_BASE_MS * 2 ** attempt);

/** Unref'd: a pending re-send never holds the process open. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

type TurnFinished = Extract<RunnerEvent, { kind: "turn.finished" }>;

const DEATH_CODES: ReadonlySet<string> = new Set([
  TURN_FAILURE_CODES.agentStartFailed,
  TURN_FAILURE_CODES.agentRestarted,
]);

/** A turn's end that may be re-sent: any but a death report. */
const isResendable = (event: RunnerEvent): event is TurnFinished =>
  event.kind === "turn.finished" &&
  !(event.errorCode !== undefined && DEATH_CODES.has(event.errorCode));

export interface ReportChain {
  /** Queue a report behind everything queued before it. */
  report: (event: RunnerEvent) => void;
  /** Resolves when everything queued so far was attempted. */
  drained: () => Promise<void>;
}

export const createReportChain = (deps: {
  post: (events: RunnerEvent[]) => Promise<void>;
  warn: (message: string, fields: Record<string, unknown>) => void;
}): ReportChain => {
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  /** sandboxId → turn ends of that sandbox awaiting a re-send. */
  const pendingResends = new Map<string, number>();
  let totalPendingResends = 0;

  const enqueue = (send: () => Promise<void>): void => {
    queued += 1;
    chain = chain.then(send).finally(() => {
      queued -= 1;
    });
  };

  const holdResend = (sandboxId: string): boolean => {
    const held = pendingResends.get(sandboxId) ?? 0;
    if (
      totalPendingResends >= MAX_PENDING_RESENDS ||
      held >= MAX_PENDING_RESENDS_PER_SANDBOX
    ) {
      return false;
    }
    pendingResends.set(sandboxId, held + 1);
    totalPendingResends += 1;
    return true;
  };

  const releaseResend = (sandboxId: string): void => {
    const left = (pendingResends.get(sandboxId) ?? 1) - 1;
    if (left > 0) pendingResends.set(sandboxId, left);
    else pendingResends.delete(sandboxId);
    totalPendingResends -= 1;
  };

  /** One post through the chain, settling with its outcome. */
  const postInOrder = (
    event: RunnerEvent,
  ): Promise<{ ok: true } | { ok: false; error: unknown }> =>
    new Promise((resolve) => {
      enqueue(() =>
        deps.post([event]).then(
          () => resolve({ ok: true }),
          (error: unknown) => resolve({ ok: false, error }),
        ),
      );
    });

  const resend = async (event: TurnFinished): Promise<void> => {
    try {
      for (let attempt = 0; attempt < MAX_RESENDS; attempt += 1) {
        await sleep(resendDelayMs(attempt));
        const outcome = await postInOrder(event);
        if (outcome.ok) return;
        if (!isProvablyUnapplied(outcome.error)) {
          deps.warn("a turn's end may have landed; not re-sending it", {
            sandboxId: event.sandboxId,
            turnId: event.turnId,
            error: String(outcome.error),
          });
          return;
        }
      }
      deps.warn("gave up re-sending a turn's end", {
        sandboxId: event.sandboxId,
        turnId: event.turnId,
      });
    } finally {
      releaseResend(event.sandboxId);
    }
  };

  const failed = (event: RunnerEvent, error: unknown): void => {
    if (
      isResendable(event) &&
      isProvablyUnapplied(error) &&
      holdResend(event.sandboxId)
    ) {
      deps.warn("failed to report a turn's end; re-sending it", {
        sandboxId: event.sandboxId,
        turnId: event.turnId,
        error: String(error),
      });
      void resend(event);
      return;
    }
    deps.warn("failed to report a supervisor message", {
      sandboxId: event.sandboxId,
      kind: event.kind,
      error: String(error),
    });
  };

  return {
    report: (event) => {
      const cap =
        event.kind === "turn.finished"
          ? MAX_QUEUED_REPORTS + TERMINAL_RESERVE
          : MAX_QUEUED_REPORTS;
      if (queued >= cap) {
        deps.warn("report queue full; dropping an event", {
          sandboxId: event.sandboxId,
          kind: event.kind,
        });
        return;
      }
      enqueue(() =>
        deps.post([event]).catch((error: unknown) => failed(event, error)),
      );
    },
    drained: () => chain,
  };
};
