import type { Logger } from "pino";
import { IS_CLOUD } from "../lib/env";
import { WORK_CLAIMED_LOG_MSG, WORK_CLAIMED_WAIT_FIELD } from "./due-work";

/**
 * The turn-queue telemetry line (step 6): one log line per claimed turn —
 * the exact shape the cloud's TurnQueueSeconds metric filter is pinned to.
 *
 * In CLOUD the line is a metric carrier and prod runs LOG_LEVEL=warn, so the
 * child logger pins its own `info` level there — or the one environment the
 * alarm watches would never produce the line. Onprem has no filter reading
 * it, so the operator's chosen root level stands. One factory, with the
 * edition injectable so the pinning behavior is testable against a real
 * warn-level root. Telemetry only: nothing thrown here may break the claim
 * path.
 */
export const createLogClaimWait = (
  base: Logger,
  isCloud: boolean = IS_CLOUD,
): ((waitedSince: Date | undefined, turnId: string) => void) => {
  const claimLog = isCloud
    ? base.child({ component: "runner-routes" }, { level: "info" })
    : base.child({ component: "runner-routes" });
  return (waitedSince, turnId) => {
    try {
      if (!waitedSince) return;
      const waitedSeconds = (Date.now() - waitedSince.getTime()) / 1000;
      if (!Number.isFinite(waitedSeconds) || waitedSeconds < 0) return;
      claimLog.info(
        { [WORK_CLAIMED_WAIT_FIELD]: waitedSeconds, turnId, kind: "turn" },
        WORK_CLAIMED_LOG_MSG,
      );
    } catch {
      // Swallowed by design — see above.
    }
  };
};
