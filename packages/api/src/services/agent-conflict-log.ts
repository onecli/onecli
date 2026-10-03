import type { Logger } from "pino";
import { IS_CLOUD } from "../lib/env";

/**
 * The agent-identifier conflict line: one log line per 409 from
 * `POST /v1/agents`, carrying WHICH identifier collided and WHY.
 *
 * Why this exists (onecli/onecli-cloud#1115): a 409 here is the SUCCESS path
 * of the SDK's idempotent `ensureAgent` — it catches 409 and resolves
 * `{created:false}`, so a long-lived client re-running `ensureAgent()` on
 * every container start produces a steady stream of them and never a 201.
 * That is healthy traffic, but the access log records only
 * method/path/status/orgId, so it is INDISTINGUISHABLE from a client stuck
 * in a real conflict. A health check read one such stream as a no-backoff
 * retry loop and filed a P3 against normal customer behavior. Nothing in the
 * 409 path said otherwise, because nothing in it logged at all.
 *
 * So the line names the identifier (the issue's own ask) and, more
 * importantly, splits the two conflicts that until now threw an IDENTICAL
 * message:
 *
 * - `existing` — the pre-check found the identifier already present. The
 *   benign, dominant `ensureAgent` path.
 * - `race` — the insert lost a unique-constraint race (Prisma P2002): two
 *   concurrent creates of the same identifier. Rare, and genuinely worth
 *   noticing.
 *
 * Level is INFO on purpose. This is an expected outcome, not a fault, and a
 * deployment may alert on `level >= WARN` — logging it as a warning would
 * recreate the very noise-vs-signal problem the issue is about. But pino
 * drops a below-level line BEFORE it is written and a production root may
 * run `LOG_LEVEL=warn`, so a naive `log.info` would never exist where it
 * matters. The child therefore pins its own `info` level in
 * CLOUD — the `claim-wait-log.ts` idiom, for the same reason: a
 * metric-carrying line the root level must not be able to silence. Onprem
 * has nothing reading it, so the operator's chosen level stands.
 *
 * Telemetry only: nothing thrown here may break agent creation.
 */
export const AGENT_CONFLICT_LOG_MSG = "agent identifier conflict";

/** Which of the two conflicts fired — the whole point of the line. */
export const AGENT_CONFLICT_REASON_FIELD = "conflictReason";

/** Pre-check hit: the identifier already exists (idempotent `ensureAgent`). */
export const AGENT_CONFLICT_REASON_EXISTING = "existing";

/** Unique-constraint race: concurrent inserts of the same identifier. */
export const AGENT_CONFLICT_REASON_RACE = "race";

export type AgentConflictReason =
  | typeof AGENT_CONFLICT_REASON_EXISTING
  | typeof AGENT_CONFLICT_REASON_RACE;

export interface AgentConflictDetails {
  workspaceId: string;
  identifier: string;
  reason: AgentConflictReason;
  /** The colliding agent — known on the pre-check, absent on the race. */
  existingAgentId?: string;
}

/**
 * Builds the conflict logger. The edition is injectable so the cloud
 * level-pinning is testable against a real warn-level root.
 */
export const createLogAgentConflict = (
  base: Logger,
  isCloud: boolean = IS_CLOUD,
): ((details: AgentConflictDetails) => void) => {
  const conflictLog = isCloud
    ? base.child({ component: "agent-service" }, { level: "info" })
    : base.child({ component: "agent-service" });
  return ({ workspaceId, identifier, reason, existingAgentId }) => {
    try {
      conflictLog.info(
        {
          workspaceId,
          identifier,
          [AGENT_CONFLICT_REASON_FIELD]: reason,
          ...(existingAgentId ? { existingAgentId } : {}),
        },
        AGENT_CONFLICT_LOG_MSG,
      );
    } catch {
      // Swallowed by design — see above.
    }
  };
};
