import { db, Prisma } from "@onecli/db";
import type { ProcessState, RunnerEvent } from "@onecli/agent-protocol";
import { resolveVerifiedContext } from "./platform-tool-service";
import { markWatchFirePending } from "./due-work";
import { logger } from "../lib/logger";

const log = logger.child({ component: "sandbox-process-service" });

/**
 * The durable mirror of a sandbox's background processes (step 10). The
 * supervisor owns liveness and reports whole `process.state` frames; this
 * service writes them, fenced and transition-guarded, so a lossy/duplicated
 * stream converges (the home.synced re-ack law, generalized to state).
 *
 * Two authenticated facts fence every write: the runner's token (via
 * `runnerId`) and the channel-stamped `sandboxId`. A THIRD — the runner's
 * `containerRef` — is what tells a live process from a stale row off a dead
 * container: sandbox rows survive respawns, `container_ref` churns. Rows are
 * keyed `(sandboxId, ref)` with a supervisor-chosen ref, so a forged ref
 * lands as that sandbox's own row and can never cross a tenant boundary.
 */

type ProcessStateEvent = Extract<RunnerEvent, { kind: "process.state" }>;

/** Terminal process states never transition again; a late frame is inert. */
const TERMINAL_PROCESS = new Set(["exited", "stopped", "lost"]);
/** Terminal watch states are likewise frozen. */
const TERMINAL_WATCH = new Set(["fired", "expired", "canceled"]);

const parseDate = (iso: string | undefined): Date | undefined =>
  iso ? new Date(iso) : undefined;

export const applyProcessState = async (
  runnerId: string,
  event: ProcessStateEvent,
): Promise<void> => {
  // Fence 1+2: the sandbox must be this runner's. A miss is silently inert
  // (the applyRunnerEvent posture) — never a signal about whether it exists.
  const sandbox = await db.sandbox.findFirst({
    where: { id: event.sandboxId, runnerId },
    select: {
      id: true,
      containerRef: true,
      agent: { select: { id: true } },
    },
  });
  if (!sandbox) return;

  // Fence 3, the container anchor. Null → heal it (the report race the
  // ref-split in applyRunnerEvent also guards); mismatch → refuse the WHOLE
  // event: it is a late frame from a container that has been replaced, and
  // the lost sweep owns those rows.
  if (sandbox.containerRef === null) {
    await db.sandbox.updateMany({
      where: { id: sandbox.id, runnerId, containerRef: null },
      data: { containerRef: event.containerRef },
    });
  } else if (sandbox.containerRef !== event.containerRef) {
    log.info(
      { sandboxId: sandbox.id },
      "process state from a stale container; refusing (lost sweep owns it)",
    );
    return;
  }

  await upsertProcess(
    sandbox.id,
    sandbox.agent.id,
    event.containerRef,
    event.process,
  );
};

const upsertProcess = async (
  sandboxId: string,
  agentId: string,
  containerRef: string,
  frame: ProcessState,
): Promise<void> => {
  const existing = await db.sandboxProcess.findUnique({
    where: { sandboxId_ref: { sandboxId, ref: frame.ref } },
    select: { id: true, status: true },
  });

  if (!existing) {
    // First sight: verify the arm-time context ONCE, write-once (a later
    // forged frame cannot re-anchor an existing row). Take the frame's state
    // verbatim — a first-seen terminal process is legal (its `running` frame
    // may have been dropped).
    const context = await resolveVerifiedContext(agentId, {
      ...(frame.conversationId && { conversationId: frame.conversationId }),
      ...(frame.turnId && { turnId: frame.turnId }),
    });
    let processId: string;
    try {
      const created = await db.sandboxProcess.create({
        data: {
          sandboxId,
          ref: frame.ref,
          // The container this frame came from, validated as the sandbox's
          // current one by applyProcessState's anchor before we got here.
          containerRef,
          command: frame.command,
          ...(frame.name && { name: frame.name }),
          status: frame.status,
          ...(frame.exitCode !== undefined && { exitCode: frame.exitCode }),
          ...(frame.signal && { signal: frame.signal }),
          ...(frame.tail && { tail: frame.tail }),
          originConversationId: context.originConversationId,
          createdByUserId: context.createdByUserId,
          startedAt: new Date(frame.startedAt),
          ...(parseDate(frame.endedAt) && {
            endedAt: parseDate(frame.endedAt),
          }),
        },
        select: { id: true },
      });
      processId = created.id;
    } catch (error) {
      // A concurrent create won the (sandboxId, ref) unique — fall through to
      // the update path against the now-existing row.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const row = await db.sandboxProcess.findUnique({
          where: { sandboxId_ref: { sandboxId, ref: frame.ref } },
          select: { id: true, status: true },
        });
        if (!row) throw error;
        processId = row.id;
        // Pass the winner's REAL status, not a literal "running": the row the
        // concurrent create landed may already be terminal, and the terminal
        // freeze must hold on this path too — a local invariant, never a bet
        // on the supervisor emitting one terminal transition per ref.
        await updateProcess(processId, row.status, frame);
      } else {
        throw error;
      }
    }
    await upsertWatches(processId, agentId, frame);
    return;
  }

  await updateProcess(existing.id, existing.status, frame);
  await upsertWatches(existing.id, agentId, frame);
};

const updateProcess = async (
  processId: string,
  currentStatus: string,
  frame: ProcessState,
): Promise<void> => {
  if (TERMINAL_PROCESS.has(currentStatus)) return; // frozen; late frame inert
  if (frame.status === "running") {
    // running → running: refresh only the mutable observational fields.
    await db.sandboxProcess.update({
      where: { id: processId },
      data: {
        ...(frame.tail !== undefined && { tail: frame.tail }),
        ...(frame.name && { name: frame.name }),
      },
    });
    return;
  }
  // running → terminal.
  await db.sandboxProcess.update({
    where: { id: processId },
    data: {
      status: frame.status,
      ...(frame.exitCode !== undefined && { exitCode: frame.exitCode }),
      ...(frame.signal && { signal: frame.signal }),
      ...(frame.tail !== undefined && { tail: frame.tail }),
      endedAt: parseDate(frame.endedAt) ?? new Date(),
    },
  });
};

const upsertWatches = async (
  processId: string,
  agentId: string,
  frame: ProcessState,
): Promise<void> => {
  for (const w of frame.watches) {
    const existing = await db.processWatch.findUnique({
      where: { processId_ref: { processId, ref: w.ref } },
      select: { id: true, status: true },
    });
    if (!existing) {
      const context = await resolveVerifiedContext(agentId, {
        ...(w.conversationId && { conversationId: w.conversationId }),
        ...(w.turnId && { turnId: w.turnId }),
      });
      await db.processWatch
        .create({
          data: {
            processId,
            ref: w.ref,
            kind: w.kind,
            ...(w.pattern !== undefined && { pattern: w.pattern }),
            ...(w.silenceSeconds !== undefined && {
              silenceSeconds: w.silenceSeconds,
            }),
            prompt: w.prompt,
            status: w.status,
            ...(w.trigger && { trigger: w.trigger }),
            ...(w.excerpt && { excerpt: w.excerpt }),
            expiresAt: new Date(w.expiresAt),
            ...(parseDate(w.triggeredAt) && {
              triggeredAt: parseDate(w.triggeredAt),
            }),
            originConversationId: context.originConversationId,
            createdByUserId: context.createdByUserId,
          },
        })
        .catch((error: unknown) => {
          // A concurrent create won the unique — the row now exists; the next
          // frame's update path converges it. Swallow only P2002.
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ) {
            return;
          }
          throw error;
        });
      continue;
    }
    if (TERMINAL_WATCH.has(existing.status)) continue; // frozen
    if (existing.status === "armed" && w.status !== "armed") {
      // armed → triggered | expired | canceled (the only edges the supervisor
      // authors; fired is CP-only and never on the wire).
      await db.processWatch.update({
        where: { id: existing.id },
        data: {
          status: w.status,
          ...(w.trigger && { trigger: w.trigger }),
          ...(w.excerpt && { excerpt: w.excerpt }),
          ...(parseDate(w.triggeredAt) && {
            triggeredAt: parseDate(w.triggeredAt),
          }),
        },
      });
      // A triggered watch is due work the parked poll cannot see (the fire
      // pass runs at the top of the handler): mark the fire pass pending
      // and wake the polls — the first taker runs ONE pass, so trigger→fire
      // drops from the 0–25s poll window to ~a second without a fire pass
      // per waiter per ordinary message.
      if (w.status === "triggered") markWatchFirePending();
    }
  }
};
