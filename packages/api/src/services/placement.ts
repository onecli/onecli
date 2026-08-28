import { db } from "@onecli/db";
import { RUNNER_ONLINE_THRESHOLD_SECONDS } from "../lib/env";
import { runnerCapabilitiesSchema } from "@onecli/agent-protocol";

/**
 * THE PLACEMENT SEAM (plans/hosted-agents-v2.md §3.17, invariant 15): the one
 * call that decides which runner a new sandbox lands on. Today that is
 * "the instance's one runner"; capacity/scope/capability-aware selection
 * across a fleet swaps in here without moving a wall.
 */

/** The cutoff a runner's heartbeat must be newer than to count as online. */
export const onlineSince = (): Date =>
  new Date(Date.now() - RUNNER_ONLINE_THRESHOLD_SECONDS * 1000);

const capacityOf = (capabilities: unknown): number => {
  const parsed = runnerCapabilitiesSchema.safeParse(capabilities);
  return parsed.success ? parsed.data.maxSandboxes : 0;
};

export interface PlacementOptions {
  /**
   * Restrict selection to these runner ids. Omit the option to consider the
   * whole instance; an empty list matches no runner (the pick returns null).
   * Production callers omit it; the pg proof suite passes its fixture
   * runners, because sibling test files heartbeat their own runners in the
   * same database and an unfenced pick would be green or red by scheduling.
   */
  candidateIds?: readonly string[];
}

/**
 * Pick the runner for a new sandbox: online, with spare capacity, least
 * loaded first. Returns null when nothing can host — the caller turns that
 * into a user-facing "no runner available" rather than a queued sandbox
 * nobody will ever start.
 *
 * Capacity counts sandboxes that occupy a slot on the runner (`stopped` ones
 * hold only a volume, so they don't).
 */
export const pickRunnerForSandbox = async (
  options?: PlacementOptions,
): Promise<string | null> => {
  const runners = await db.runner.findMany({
    where: {
      lastSeenAt: { gte: onlineSince() },
      ...(options?.candidateIds !== undefined && {
        id: { in: [...options.candidateIds] },
      }),
    },
    select: {
      id: true,
      capabilities: true,
      _count: {
        select: {
          sandboxes: {
            where: { status: { in: ["unprovisioned", "starting", "running"] } },
          },
        },
      },
    },
  });

  const eligible = runners
    .map((runner) => ({
      id: runner.id,
      load: runner._count.sandboxes,
      capacity: capacityOf(runner.capabilities),
    }))
    .filter((runner) => runner.load < runner.capacity)
    .sort((a, b) => a.load - b.load);

  return eligible[0]?.id ?? null;
};
