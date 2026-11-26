import { db } from "@onecli/db";
import { signalWork } from "./due-work";
import { findAgentLlmBlocker } from "./llm-credential-service";
import { logger } from "../lib/logger";

const log = logger.child({ component: "sandbox-warm-service" });

/**
 * A person is about to want this agent: start waking a parked box NOW, so
 * whatever they do next (type a message, open a section, click Chat) finds
 * it awake instead of paying the whole boot inside the first turn.
 *
 * Every door that means "a person is heading for this agent" calls this and
 * nothing else: the thread open, the agent page's mount, the Chat button's
 * hover, the agents list. It is a HINT, deliberately narrower than the wake a
 * message performs (`wakeSandboxFor`):
 *
 * - Only `stopped`. A `failed` box is a start that did not work, and the
 *   start arm paces its retries; looking at an agent must not be a way
 *   around that backoff.
 * - Never for an agent that cannot run (`findAgentLlmBlocker`): the start
 *   would be refused at compose time and parked `failed`, which is churn and
 *   a failure the person never asked for. Their first message reports the
 *   missing key the ordinary way.
 * - Not engagement. The idle clock is left alone: a box woken by a look and
 *   then unused goes back to sleep on the ordinary idle window, and its
 *   awake time is the honest cost of the head start.
 * - Idempotent and cheap to repeat: the first call flips the row, every
 *   later one is one indexed read that finds nothing `stopped`. Callers may
 *   fire it on every hover.
 *
 * The start arm claims an `unprovisioned` box whatever its queue holds (the
 * same door the desktop and SSH wakes ride), and `signalWork` hands it to
 * the held runner poll at once. Best-effort: the caller's own answer never
 * depends on it, so a failure here is a log line, never an error.
 */
export const warmAgentSandbox = async (
  workspaceId: string,
  agentId: string,
): Promise<void> => {
  try {
    const parked = await db.sandbox.findFirst({
      where: { agentId, status: "stopped", agent: { workspaceId } },
      select: { id: true },
    });
    if (!parked) return;
    if (await findAgentLlmBlocker(workspaceId, agentId)) return;
    const { count } = await db.sandbox.updateMany({
      where: { id: parked.id, status: "stopped" },
      data: { status: "unprovisioned", wakeReason: null },
    });
    if (count > 0) signalWork();
  } catch (err) {
    log.info({ err: String(err), agentId }, "warm wake skipped");
  }
};
