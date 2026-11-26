import type { Logger } from "pino";
import { IS_CLOUD } from "../lib/env";
import { WORK_CLAIMED_LOG_MSG, WORK_CLAIMED_WAIT_FIELD } from "./due-work";

/**
 * The turn-queue telemetry line: one log line per claimed turn — the exact
 * shape a deployment's log-based metric can match on.
 *
 * In CLOUD the line is a metric carrier and the root level may be
 * LOG_LEVEL=warn, so the child logger pins its own `info` level there — or
 * the line would never be produced. Onprem has no metric reading
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
