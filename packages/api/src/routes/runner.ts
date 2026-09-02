import { Hono } from "hono";
import {
  runnerEventsRequestSchema,
  runnerHeartbeatRequestSchema,
  runnerRegisterRequestSchema,
  runnerMemoryWriteRequestSchema,
  runnerSandboxCheckRequestSchema,
  runnerToolCallRequestSchema,
  runnerWorkRequestSchema,
  type RunnerWorkItem,
} from "@onecli/agent-protocol";
import { runnerAuth, type RunnerEnv } from "../middleware/runner-auth";
import { NO_MODEL_KEY_MESSAGE } from "../validations/conversation";
import {
  claimDueWork,
  expireWedgedFollowUps,
  failStalledTurns,
  reclaimStaleTurns,
  releaseClaim,
  parkUnstartableClaim,
  takeWatchFirePending,
  waitForWork,
} from "../services/due-work";
import { createLogClaimWait } from "../services/claim-wait-log";
import { fireDueCrons } from "../services/cron-fire-service";
import { fireDueWatches } from "../services/watch-fire-service";
import { promoteParkedFollowUps } from "../services/follow-up-service";
import { applyProcessState } from "../services/sandbox-process-service";
import {
  heartbeatRunner,
  registerRunner,
  runnerSupportsAttachments,
} from "../services/runner-service";
import {
  getAttachmentBytesForRunner,
  planTurnAttachments,
  sweepStalePendingAttachments,
} from "../services/attachment-service";
import { sweepSshSessions } from "../services/ssh-service";
import {
  applyRunnerEvent,
  buildSandboxStartPayload,
  listMissingSandboxIds,
  listRunnerSandboxes,
} from "../services/sandbox-service";
import {
  applyTurnEvents,
  applyTurnProgress,
  finishTurn,
  settleSweptTurns,
} from "../services/turn-service";
import { buildTurnContext } from "../services/turn-context-service";
import { MAX_TURN_CONTEXT_CHARS } from "@onecli/agent-protocol";
import { activityForTool } from "@onecli/agent-protocol/activity";
import type { AgentEvent } from "@onecli/agent-protocol";
import { narrateTurnActivity } from "../services/channels/turn-receipt-service";
import { buildHomeSyncItem } from "../services/home-sync-service";
import {
  executeMemoryFileWrite,
  executePlatformTool,
} from "../services/platform-tool-service";
import { logger } from "../lib/logger";

const log = logger.child({ component: "runner-routes" });

/**
 * Narrate a batch's work onto the turn's channel loader.
 *
 * TOOL CALLS ONLY, deliberately. `tool.started` is durable and coarse — a
 * handful per turn — which is what keeps this far away from the ~2s edit
 * loop the de-streaming amendment removed. Reasoning (`thinking.delta`)
 * is NOT used: it is ephemeral by the delta law, arrives token-by-token,
 * and narrating it would reintroduce exactly that cadence.
 *
 * Only the LAST tool in a batch is sent — intermediate rows are already
 * stale by the time the batch lands.
 *
 * Detached (`void`): the caller must not wait on a channel round-trip to
 * ack a runner batch.
 *
 * Exported for its test: which event becomes a row, and when nothing is
 * said, is the whole behavior — worth pinning without standing up a Hono
 * app, a runner token, and a database around it.
 */
export const pushTurnNarration = (
  turnId: string,
  events: AgentEvent[],
): void => {
  let activity: string | undefined;
  for (const event of events) {
    // A terminal event ends the turn, and the clear path owns taking the
    // narration down. Saying anything now would describe finished work.
    if (event.type === "turn.done" || event.type === "error") return;
    if (event.type === "tool.started") activity = activityForTool(event.name);
  }
  if (!activity) return;
  void narrateTurnActivity(turnId, activity);
};

/** The turn-queue telemetry line — see services/claim-wait-log.ts. */
const logClaimWait = createLogClaimWait(logger);

/**
 * The runner daemon's API (plans/hosted-agents-v2.md §3.3): outbound-only, so
 * everything here is the runner calling in — register, long-poll for work,
 * report events, heartbeat. Authenticated ONLY by the `rnr_` family
 * (`runnerAuth`); this surface never accepts a user API key, and an `rnr_`
 * token never reaches the general `/v1` surface.
 */

/** How long a held poll may sit. Bounded well under the api-server's 70s
 * keep-alive and cloud's 65s ALB idle timeout, so a poll always returns an
 * answer rather than being cut mid-flight. */
const MAX_WAIT_SECONDS = 25;
const DEFAULT_LIMIT = 5;
/** Re-check cadence inside a held poll — the floor on wake latency when the
 * in-process signal is missed (a second api instance, a signal thrown away). */
const RECHECK_MS = 1000;

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

export const runnerRoutes = () => {
  const app = new Hono<RunnerEnv>();

  /**
   * POST /runner/register — the only unauthenticated-by-middleware route:
   * the token IS the request's subject, checked by the service against an
   * existing runner or the instance's registration anchor.
   */
  app.post("/register", async (c) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token.startsWith("rnr_"))
      return c.json({ error: "Unauthorized" }, 401);

    const body = await parseBody(c.req.raw);
    const parsed = runnerRegisterRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const result = await registerRunner({ token, ...parsed.data });
    if (!result.ok) return c.json({ error: "Unauthorized" }, 401);

    log.info({ runnerId: result.runnerId }, "runner registered");
    return c.json({ runnerId: result.runnerId });
  });

  app.use("*", runnerAuth);

  /**
   * POST /runner/work — the long poll. Claims are atomic and runner-fenced
   * (the due-work seam); when nothing is due the request is held briefly,
   * racing the work signal, so a created agent starts in about a second
   * without a background loop anywhere.
   */
  app.post("/work", async (c) => {
    const { runnerId } = c.get("runner");
    const body = await parseBody(c.req.raw);
    const parsed = runnerWorkRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    // The control plane has no background loop (§3.3), so the poll is also
    // where overdue work gets swept. Failure is not fatal: the sweep is a
    // recovery path, and losing one pass costs one poll interval — never
    // taking the poll itself down, which would stop dispatch entirely.
    //
    // Each sweep's settle rides its own chain: the sweeps' raw UPDATEs bypass
    // `finishTurn` (whose late real report is a fenced no-op), so the
    // returned rows are the ONLY chance to book a swept cron/watch run's
    // outcome and deliver its report. Paired here rather than inside
    // due-work because turn-service already imports due-work (`signalWork`).
    await reclaimStaleTurns()
      .then(settleSweptTurns)
      .catch((err: unknown) => log.warn({ err }, "stale-turn sweep failed"));

    // The liveness arm: RUNNING turns whose supervisor heartbeat went silent.
    // Right after the ceiling sweep, same posture — recovery first, dispatch
    // second. The abort the sweep flags is claimed further down this very
    // poll (claimDueWork's abort arm), so fail and stop land together.
    await failStalledTurns()
      .then(settleSweptTurns)
      .catch((err: unknown) => log.warn({ err }, "stalled-turn sweep failed"));

    // Scheduled tasks fire here too (step 7): dueness is computed at poll
    // time, and a fire is just a turn creation — the claim arms below then
    // deliver it like any other queued work. Same non-fatal posture as the
    // sweep; poll cadence bounds cron precision (seconds), which is the
    // right precision for cron (§3.3).
    await fireDueCrons().catch((err: unknown) =>
      log.warn({ err }, "cron fire pass failed"),
    );

    // Background-process watches fire here too (step 10). Its internal sweeps
    // (lost/coherence/expiry) run first, so THIS poll's stop-arm below already
    // sees a lost process's conversions — a dying process never spuriously
    // holds a sandbox awake for one extra interval. Same non-fatal posture.
    await fireDueWatches().catch((err: unknown) =>
      log.warn({ err }, "watch fire pass failed"),
    );

    // Parked follow-ups whose target closed without promoting them (a crash
    // in the close window, a settle frame that never arrived). The PRIMARY
    // promotion is inline in finishTurn — this is the recovery backstop,
    // same non-fatal posture as the sweeps above. The wedge sweep runs AFTER
    // it, deliberately: promotion re-occupies a just-freed conversation, so
    // the sweep only ever reaches follow-ups nothing can promote.
    await promoteParkedFollowUps().catch((err: unknown) =>
      log.warn({ err }, "follow-up promotion pass failed"),
    );
    await expireWedgedFollowUps().catch((err: unknown) =>
      log.warn({ err }, "wedged follow-up sweep failed"),
    );
    // Uploads nobody ever sent (a closed tab, an abandoned draft). Indexed
    // and empty almost always; same non-fatal posture as the sweeps above.
    await sweepStalePendingAttachments().catch((err: unknown) =>
      log.warn({ err }, "stale attachment sweep failed"),
    );
    // SSH sessions a crashed terminator abandoned (sandbox-platform step 5):
    // lease-expired rows are closed here so the per-agent cap and the audit
    // record stay honest — keep-awake already ignores them (the lease is the
    // truth). Same non-fatal posture.
    await sweepSshSessions().catch((err: unknown) =>
      log.warn({ err }, "ssh session sweep failed"),
    );

    const limit = parsed.data.limit ?? DEFAULT_LIMIT;
    const deadline =
      Date.now() + Math.min(parsed.data.wait ?? 0, MAX_WAIT_SECONDS) * 1000;

    // Resolved lazily, once per poll, only when a claimed turn needs it.
    let attachmentsCapable: boolean | null = null;

    for (;;) {
      const claimed = await claimDueWork(runnerId, limit);
      if (claimed.length > 0) {
        const items: RunnerWorkItem[] = [];
        for (const due of claimed) {
          if (due.kind === "turn") {
            logClaimWait(due.waitedSince, due.turnId);
            // The memory context (step 8) is composed here, at dispatch time,
            // from current truth — and a failing builder ships the turn
            // WITHOUT context rather than blocking it: memory flavors a turn,
            // it never gates one.
            const context = await buildTurnContext(
              due.agentId,
              due.conversationId,
              due.turnId,
              due.message,
            ).catch((err: unknown) => {
              log.warn(
                { err, turnId: due.turnId },
                "turn context build failed; delivering without it",
              );
              return null;
            });

            // Attachments (metadata + note only — the runner PULLS bytes).
            // Composed exclusively for capable runners: telling the agent
            // about files that cannot arrive would be worse than silence.
            // Same non-blocking posture as the context builder.
            attachmentsCapable ??= await runnerSupportsAttachments(runnerId);
            const plan = attachmentsCapable
              ? await planTurnAttachments(due.turnId).catch((err: unknown) => {
                  log.warn(
                    { err, turnId: due.turnId },
                    "attachment plan failed; delivering without it",
                  );
                  return null;
                })
              : null;
            // The note leads (the files belong to THIS message); the memory
            // context follows; one slice holds the combined budget.
            const combinedContext = [plan?.note, context]
              .filter((part): part is string => Boolean(part))
              .join("\n\n")
              .slice(0, MAX_TURN_CONTEXT_CHARS);

            items.push({
              kind: "turn.deliver",
              sandboxId: due.sandboxId,
              conversationId: due.conversationId,
              turnId: due.turnId,
              message: due.message,
              ...(due.resumeSessionRef && {
                resumeSessionRef: due.resumeSessionRef,
              }),
              ...(combinedContext && { context: combinedContext }),
              ...(plan && plan.manifest.length > 0
                ? { attachments: plan.manifest }
                : {}),
            });
            continue;
          }
          if (due.kind === "turn.abort") {
            items.push({
              kind: "turn.abort",
              sandboxId: due.sandboxId,
              conversationId: due.conversationId,
              turnId: due.turnId,
            });
            continue;
          }
          if (due.kind === "turn.message") {
            // Steers carry the raw follow-up text only — no dispatch-time
            // context: the live turn's session already has the target's, and
            // the message rides into it verbatim.
            items.push({
              kind: "turn.message",
              sandboxId: due.sandboxId,
              conversationId: due.conversationId,
              turnId: due.turnId,
              targetTurnId: due.targetTurnId,
              message: due.message,
            });
            continue;
          }
          if (due.kind === "home.sync") {
            // Composed at dispatch time from current truth, like everything
            // else here. A failing composer keeps the claim's pacing stamp —
            // the 60s window IS the retry — and never blocks the batch.
            const item = await buildHomeSyncItem(
              due.agentId,
              due.sandboxId,
              due.generation,
            ).catch((err: unknown) => {
              log.warn(
                { err, sandboxId: due.sandboxId },
                "home sync compose failed; the paced window will retry",
              );
              return null;
            });
            if (item) items.push(item);
            continue;
          }
          if (due.kind === "stop") {
            items.push({
              kind: "sandbox.stop",
              sandboxId: due.sandboxId,
              ...(due.containerRef && { containerRef: due.containerRef }),
            });
            continue;
          }
          // Payloads are composed here, at dispatch time, from current truth.
          // Per-item try/catch: a transient database error while composing one
          // sandbox must not strand the whole claimed batch in `starting`
          // until the stale window expires — the others are already composed
          // and perfectly deliverable.
          try {
            const spawn = await buildSandboxStartPayload(
              due.sandboxId,
              runnerId,
            );
            if (!spawn.ok) {
              if (spawn.reason === "no_llm_credential") {
                // Not transient: it stays true until someone grants a key, so
                // releasing the claim would re-claim it on the very next poll,
                // forever. Park it where the start arm's backoff applies, and
                // fail the turns that were waiting on it.
                await parkUnstartableClaim(due.sandboxId, runnerId, {
                  message: NO_MODEL_KEY_MESSAGE,
                  code: "no_model_key",
                });
              } else {
                // The agent vanished, or the CA is not ready — put the claim
                // back rather than shipping a half-formed spawn.
                await releaseClaim(due.sandboxId, runnerId);
              }
              continue;
            }
            items.push({
              kind: "sandbox.start",
              sandboxId: due.sandboxId,
              agentId: spawn.agentId,
              payload: spawn.payload,
            });
          } catch (err) {
            log.warn(
              { err, sandboxId: due.sandboxId },
              "failed to compose spawn payload; releasing the claim",
            );
            await releaseClaim(due.sandboxId, runnerId).catch(() => {});
          }
        }
        if (items.length > 0) return c.json({ items });
        // Work was due but none of it could be composed — the CA isn't ready,
        // or the agents vanished. Answer now instead of holding: re-claiming
        // the same rows every second for the rest of the window would churn
        // the database hardest exactly when the deployment is unhealthy, and
        // the runner's next poll is the natural retry.
        return c.json({ items: [] });
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return c.json({ items: [] });
      const signaled = await waitForWork(Math.min(remaining, RECHECK_MS));
      // A SIGNAL wake with the watch-fire mark pending means a watch just
      // flipped to triggered — run the fire pass here so trigger→fire is
      // ~a second. The take() is one-shot, so of all the polls a signal
      // wakes, exactly one pays for the pass, and ordinary signals (each
      // message wakes every held poll) never run it at all.
      if (signaled && takeWatchFirePending()) {
        await fireDueWatches().catch((err: unknown) =>
          log.warn({ err }, "in-hold watch fire pass failed"),
        );
      }
    }
  });

  /** POST /runner/events — batched lifecycle reports, fenced by runner. */
  app.post("/events", async (c) => {
    const { runnerId } = c.get("runner");
    const body = await parseBody(c.req.raw);
    const parsed = runnerEventsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    // Two different destinations: sandbox state goes to the sandbox record,
    // turn events go to the transcript and the live bus. An exhaustive switch,
    // so a future event kind is a compile error rather than a silent drop.
    //
    // EVERY arm is fenced by what was AUTHENTICATED, never by what the payload
    // claims: `runnerId` from the bearer token, and — for turn traffic —
    // `sandboxId`, which the runner stamps from the control channel the
    // supervisor authenticated on. The conversation and turn ids are chosen by
    // the sandbox, so an unfenced write would let any `rnr_` token, or any one
    // sandbox, reach another tenant's transcript.
    //
    // Applied ONE AT A TIME, each isolated. A batch is not all-or-nothing:
    // `deliverTurn` posts `turn.finished` together with `sandbox.status:
    // stopped` precisely when things are already going wrong, and that second
    // event exists to correct the control plane's stale `running` belief. A
    // throw on the first taking the rest of the batch with it would strand
    // exactly the sandbox the pair was sent to rescue — and the runner never
    // retries a failed report.
    let applied = 0;
    for (const event of parsed.data.events) {
      try {
        switch (event.kind) {
          case "sandbox.status":
          case "supervisor.ready":
          case "home.synced":
            await applyRunnerEvent(runnerId, event);
            break;
          case "turn.events": {
            const accepted = await applyTurnEvents(
              { runnerId, sandboxId: event.sandboxId },
              event.conversationId,
              event.turnId,
              event.events,
            );
            // The channel's narration rides the SAME batch the web reads —
            // one source, two consumers — and ONLY when the transcript
            // accepted it: a batch from a sandbox that does not host this
            // turn is ignored there, and must not drive another tenant's
            // channel thread here.
            //
            // Detached and best-effort: narration decorates a loader that is
            // already standing, so it must never delay an ack or fail a
            // batch. Wired HERE rather than inside `applyTurnEvents` because
            // the transcript service has no channel dependency and should
            // not grow one — routes are where the two meet.
            if (accepted) pushTurnNarration(event.turnId, event.events);
            break;
          }
          case "turn.progress":
            await applyTurnProgress(
              { runnerId, sandboxId: event.sandboxId },
              event.conversationId,
              event.turnId,
            );
            break;
          case "turn.finished":
            await finishTurn({
              reporter: { runnerId, sandboxId: event.sandboxId },
              conversationId: event.conversationId,
              turnId: event.turnId,
              status: event.status,
              error: event.error,
              errorCode: event.errorCode,
              usage: event.usage,
              sessionRef: event.sessionRef,
              followUps: event.followUps,
            });
            break;
          case "process.state":
            // Background-process state (step 10): its own service, not
            // applyRunnerEvent — different shape, its own fencing.
            await applyProcessState(runnerId, event);
            break;
          default: {
            const unreachable: never = event;
            throw new Error(
              `unhandled runner event: ${JSON.stringify(unreachable)}`,
            );
          }
        }
        applied += 1;
      } catch (err) {
        log.warn({ err, runnerId, kind: event.kind }, "runner event failed");
      }
    }

    // A wholly failed batch answers 500 so the failure is visible to the
    // runner and its logs; a partial one does not, because the survivors
    // landed and a re-post would duplicate them.
    if (applied === 0) {
      return c.json({ error: "Failed to apply any event" }, 500);
    }
    return c.body(null, 204);
  });

  /** POST /runner/heartbeat — liveness when the runner is busy, not polling. */
  /**
   * POST /runner/tool-call — a platform-tool invocation relayed from a
   * sandbox (step 7). Always answers 200 with a `{ok, result|error}` the
   * MODEL ultimately reads; the fence lives in the service (two-fact:
   * runner token + channel-stamped sandbox), and a fence miss is a
   * hint-free tool error, never a status-code oracle.
   */
  app.post("/tool-call", async (c) => {
    const { runnerId } = c.get("runner");
    const body = await parseBody(c.req.raw);
    const parsed = runnerToolCallRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    return c.json(await executePlatformTool(runnerId, parsed.data));
  });

  /**
   * POST /runner/memory-write — a harvested `memory/` file edit relayed from
   * a sandbox (the projection's write-back half). The tool-call shape
   * exactly: always 200 with `{ok, …|error}` for a parseable request, fence
   * in the service, hint-free misses. A schema failure IS a 400 — the
   * harvester treats it as a non-retryable refusal for this content.
   */
  app.post("/memory-write", async (c) => {
    const { runnerId } = c.get("runner");
    const body = await parseBody(c.req.raw);
    const parsed = runnerMemoryWriteRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    return c.json(await executeMemoryFileWrite(runnerId, parsed.data));
  });

  app.post("/heartbeat", async (c) => {
    const { runnerId } = c.get("runner");
    const body = await parseBody(c.req.raw);
    const parsed = runnerHeartbeatRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await heartbeatRunner(runnerId, parsed.data.capabilities);
    return c.body(null, 204);
  });

  /**
   * GET /runner/sandboxes — what this runner should be hosting. The runner
   * reconciles its local containers against this: anything labeled as ours
   * and absent here is an orphan to destroy (which is how agent deletion
   * reaches the compute plane). `statuses` rides along (additive-optional on
   * the wire) so reconcile can also run the reverse diff — a sandbox believed
   * `running` with no backend snapshot is a pod that vanished out-of-band.
   */
  app.get("/sandboxes", async (c) => {
    const { runnerId } = c.get("runner");
    const rows = await listRunnerSandboxes(runnerId);
    return c.json({
      sandboxIds: rows.map((row) => row.id),
      statuses: Object.fromEntries(rows.map((row) => [row.id, row.status])),
    });
  });

  /**
   * POST /runner/sandboxes/check — the stale-label orphan sweep's authority
   * (step 13): which of these sandbox ids exist NOWHERE in the control
   * plane. Deliberately not fenced to the caller's own sandboxes — a
   * stale-label orphan carries some other (dead) runner's label, and
   * existence anywhere is exactly the property that protects live siblings.
   * Exposes only "this id is unknown", nothing about ids that DO exist.
   */
  app.post("/sandboxes/check", async (c) => {
    const parsed = runnerSandboxCheckRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid check request" }, 400);
    }
    return c.json({
      missing: await listMissingSandboxIds(parsed.data.sandboxIds),
    });
  });

  /**
   * GET /runner/attachments/:id — the byte pull behind a `turn.deliver`
   * manifest. Bytes deliberately never ride the poll JSON (a claimed batch
   * could reach hundreds of MB and one failed parse would poison every
   * re-dispatch); the runner fetches each file here and chunks it onto the
   * sandbox socket itself. Fenced by the two-fact law in the service: the
   * attachment must be bound to a turn whose agent's sandbox sits on THIS
   * runner. Hint-free 404 on any miss.
   */
  app.get("/attachments/:attachmentId", async (c) => {
    const { runnerId } = c.get("runner");
    const found = await getAttachmentBytesForRunner(
      c.req.param("attachmentId"),
      runnerId,
    );
    if (!found) return c.json({ error: "Not found" }, 404);
    return c.body(new Uint8Array(found.bytes), 200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(found.bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
  });

  return app;
};
