/**
 * The desktop's control plane: what the Computer section reads, the lease a person holds while they drive the
 * screen, the agent's `request_human_takeover` ask, and the hand-back that
 * resumes the agent.
 *
 * One row per agent (`DesktopSession`, created on first touch) carries two
 * independent facts:
 *
 *   - the CONTROL LEASE: `controllerUserId` + `controlExpiresAt`, held by at
 *     most one person, renewed by the relay's activity heartbeat while
 *     their stream is open, and released by them (Stop) or by the sweep
 *     when the heartbeat stops (a closed tab). A lease is "live" only while
 *     unexpired, everywhere it is read: a stale row is exactly as free as
 *     an empty one, so a crashed release can never wedge a desktop.
 *   - the PENDING REQUEST: the agent's one open ask (`requestId`, reason,
 *     origin turn) and the channel cards it posted. Settled by the first
 *     hand-back after it, or by the sweep after a day.
 *
 * The sandbox learns about the lease through the runner poll: every take
 * and release NULLs `controlPushedAt`, due-work claims the row and emits
 * `desktop.control` with the controller state of that moment (so two flips
 * inside one poll collapse to the last). The supervisor is idempotent on
 * it and steers the live turn itself; this service steers nothing and only
 * creates a NEW turn when the hand-back finds the agent idle.
 *
 * Hosts come from two platform-owned `SandboxPort` rows of kind "desktop"
 * (the view port and the control port), minted lazily on the first read of
 * an available desktop and never listed, counted, or revocable with the
 * previews (`sandbox-port-service`).
 */

import { db, Prisma } from "@onecli/db";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DESKTOP_CONTROL_PORT,
  DESKTOP_VIEW_PORT,
  MAX_DESKTOP_CONTROLLER_NAME_CHARS,
} from "@onecli/agent-protocol";
import { ServiceError } from "../../services/errors";
import { previewsEnabled } from "../../lib/preview-availability";
import { configuredAppUrl } from "../../lib/app-origin";
import { logger } from "../../lib/logger";
import { cleanLabel } from "../../lib/format";
import { getCrypto } from "../../providers";
import {
  previewHostname,
  desktopSlug,
} from "../../services/sandbox-port-service";
import { createTurn, wakeSandboxFor } from "../../services/turn-service";
import { signalWork, markSandboxEngaged } from "../../services/due-work";
import { writeConversationNotice } from "../../services/conversation-notice";
import { userIsOrgAdmin } from "../../services/workspace-access-check";
import { plainReason } from "../../services/preview-expose-service";
import {
  cardRefsOf,
  dmReachableOwners,
} from "../../services/channels/agent-reach-service";
import { slackDesktopRequestCard } from "./slack-card";
import {
  ACTIVE_TURN_STATUSES,
  DESKTOP_RESUME_SOURCE,
} from "../../validations/conversation";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../../services/audit-service";

const log = logger.child({ component: "desktop-service" });

/**
 * How long a lease lives without a heartbeat. The relay reports the
 * controller's open stream once at open and once per beat (60 s), so the
 * lease is two beats: one late beat never drops a live controller, and a
 * closed tab hands control back within about two minutes (the bar copy
 * says so).
 */
export const CONTROL_LEASE_MS = 120 * 1000;
/** A pending ask nobody answered: settled `expired` after this. */
export const REQUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The agent's reason on the request, bounded like a tool argument. */
export const MAX_REQUEST_REASON_CHARS = 300;

/** The `request_human_takeover` tool's arguments, as the model sends them. */
export const takeoverArgsSchema = z
  .object({
    reason: z.string().trim().min(1).max(MAX_REQUEST_REASON_CHARS),
  })
  .strict();

/**
 * What the screen is doing: `asleep` (no running box; Wake starts one),
 * `waking` (running, the supervisor has not reported the screen yet),
 * `awake` (watchable), `unviewable` (running, and nobody can watch the
 * screen: the image has no VNC server, or the desktop never came up, so
 * the dashboard says so).
 */
export type DesktopSandboxState = "asleep" | "waking" | "awake" | "unviewable";

export interface DesktopState {
  /** Previews configured, the agent hosted, and the box reporting a
   * viewable screen. When false the rest is empty and the section says why
   * through `sandboxState`. */
  available: boolean;
  sandboxState: DesktopSandboxState;
  /** The view share's hostname (the WebSocket target), when available. */
  viewHost: string | null;
  /** The control share's hostname: ONLY for the caller holding the lease. */
  controlHost: string | null;
  controller: { userId: string; name: string; since: string } | null;
  request: { id: string; reason: string; at: string } | null;
  you: { controlling: boolean };
}

const sessionSelect = {
  id: true,
  agentId: true,
  workspaceId: true,
  controllerUserId: true,
  controlTakenAt: true,
  controlExpiresAt: true,
  requestId: true,
  requestReason: true,
  requestedAt: true,
  requestConversationId: true,
  requestTurnId: true,
  requestCardRefs: true,
} satisfies Prisma.DesktopSessionSelect;
type SessionRow = Prisma.DesktopSessionGetPayload<{
  select: typeof sessionSelect;
}>;

/** A user's label on the Computer section and in the agent's words. */
type NamedUser = { name: string | null; email: string } | null;

const leaseLive = (
  session: { controllerUserId: string | null; controlExpiresAt: Date | null },
  now = Date.now(),
): boolean =>
  session.controllerUserId !== null &&
  session.controlExpiresAt !== null &&
  session.controlExpiresAt.getTime() > now;

/**
 * The agent, fenced to the workspace, with what the state needs. Not-found
 * shaped for a foreign or missing agent, like every agent surface.
 */
const requireHostedAgent = async (workspaceId: string, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      id: true,
      name: true,
      identifier: true,
      kind: true,
      sandbox: { select: { status: true, desktopViewable: true } },
      desktopSession: {
        select: {
          controllerUserId: true,
          controlTakenAt: true,
          controlExpiresAt: true,
          requestId: true,
          requestReason: true,
          requestedAt: true,
          controller: { select: { name: true, email: true } },
        },
      },
    },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  return agent;
};

const sandboxStateOf = (
  sandbox: { status: string; desktopViewable: boolean | null } | null,
): DesktopSandboxState => {
  if (!sandbox) return "asleep";
  if (sandbox.status === "running") {
    if (sandbox.desktopViewable === null) return "waking";
    return sandbox.desktopViewable ? "awake" : "unviewable";
  }
  // `unprovisioned` is a wake already asked for and not yet claimed by a
  // runner (what a wake sets, and what a fresh agent starts as): the box
  // is on its way up, and the section should say so rather than offer
  // Wake again.
  return sandbox.status === "starting" || sandbox.status === "unprovisioned"
    ? "waking"
    : "asleep";
};

/**
 * The two platform shares of an agent's screen, minted on first need.
 * Idempotent: the (agent, port) unique key makes a racing pair of reads
 * converge on one row each; the loser's upsert is a no-op `update: {}`.
 * Never revoked: a desktop share has no toggle, it exists while the agent
 * does (the FK cascade removes it with the agent).
 *
 * A row on a desktop port that is NOT a live desktop share is repaired in
 * place: before these ports were reserved, a person could share 5900/5901
 * as a preview, and that row (kind "preview", maybe revoked) would win the
 * unique key forever, so the ticket route and the relay, which both demand
 * a desktop share, refused the screen for good. The repair re-mints the
 * slug, so the old preview hostname stops resolving at once.
 */
const ensureDesktopShare = async (agent: {
  id: string;
  identifier: string;
}): Promise<{ viewHost: string; controlHost: string }> => {
  const hostFor = async (port: number) => {
    const row = await db.sandboxPort.upsert({
      where: { agentId_port: { agentId: agent.id, port } },
      update: {},
      create: {
        agentId: agent.id,
        port,
        kind: "desktop",
        slug: desktopSlug(agent.identifier, port),
        visibility: "private",
      },
      select: { slug: true, kind: true, revokedAt: true, visibility: true },
    });
    if (
      row.kind === "desktop" &&
      row.revokedAt === null &&
      row.visibility === "private"
    )
      return previewHostname(row.slug);
    // Fenced on the row's old slug, so two repairing reads converge: one
    // rewrites it, the other re-reads the winner's.
    const { count: repairedCount } = await db.sandboxPort.updateMany({
      where: { agentId: agent.id, port, slug: row.slug },
      data: {
        kind: "desktop",
        slug: desktopSlug(agent.identifier, port),
        visibility: "private",
        revokedAt: null,
        expiresAt: null,
        approvalId: null,
        createdByUserId: null,
      },
    });
    if (repairedCount > 0) {
      log.info(
        {
          agentId: agent.id,
          port,
          previousKind: row.kind,
          wasRevoked: row.revokedAt !== null,
        },
        "repaired a legacy share on a desktop port into the desktop share",
      );
    }
    const repaired = await db.sandboxPort.findUniqueOrThrow({
      where: { agentId_port: { agentId: agent.id, port } },
      select: { slug: true },
    });
    return previewHostname(repaired.slug);
  };
  return {
    viewHost: await hostFor(DESKTOP_VIEW_PORT),
    controlHost: await hostFor(DESKTOP_CONTROL_PORT),
  };
};

const displayName = (user: NamedUser): string =>
  cleanLabel(
    user?.name || user?.email || "",
    MAX_DESKTOP_CONTROLLER_NAME_CHARS,
  ) || "Someone";

/** What the Computer section renders, for this viewer. */
export const desktopFor = async (
  workspaceId: string,
  agentId: string,
  viewerUserId: string,
): Promise<DesktopState> => {
  const agent = await requireHostedAgent(workspaceId, agentId);
  const available =
    previewsEnabled() &&
    agent.kind === "hosted" &&
    agent.sandbox?.status === "running" &&
    agent.sandbox.desktopViewable === true;
  const session = agent.desktopSession;
  const now = Date.now();
  const controlling =
    session !== null && leaseLive(session, now)
      ? session.controllerUserId === viewerUserId
      : false;
  const hosts = available ? await ensureDesktopShare(agent) : null;
  return {
    available,
    sandboxState: sandboxStateOf(agent.sandbox),
    viewHost: hosts?.viewHost ?? null,
    controlHost: controlling ? (hosts?.controlHost ?? null) : null,
    controller:
      session && leaseLive(session, now) && session.controllerUserId
        ? {
            userId: session.controllerUserId,
            name: displayName(session.controller),
            since: (session.controlTakenAt ?? new Date(now)).toISOString(),
          }
        : null,
    request:
      session?.requestId && session.requestReason !== null
        ? {
            id: session.requestId,
            reason: session.requestReason,
            at: (session.requestedAt ?? new Date(now)).toISOString(),
          }
        : null,
    you: { controlling },
  };
};

/**
 * Start the sandbox for a person who wants to see the screen. No turn (the
 * agent has nothing to do), just the same wake a preview visit triggers,
 * with the held poll signalled so the boot starts now.
 */
export const wakeDesktop = async (
  workspaceId: string,
  agentId: string,
): Promise<void> => {
  const agent = await requireHostedAgent(workspaceId, agentId);
  if (!previewsEnabled() || agent.kind !== "hosted") {
    throw new ServiceError(
      "UNPROCESSABLE",
      "The desktop is only available for hosted agents",
    );
  }
  await wakeSandboxFor(agent.id);
  signalWork();
};

export interface DesktopActor {
  userId: string;
  userEmail: string;
  organizationId: string;
}

/**
 * Take the lease. One atomic conditional update is the whole race fence:
 * the row is claimed only if nobody holds a live lease, so two people
 * clicking together get exactly one controller and one 409. Re-taking
 * your own live lease just renews it (a reconnecting tab).
 */
export const takeControl = async (
  workspaceId: string,
  agentId: string,
  actor: DesktopActor,
): Promise<DesktopState> => {
  const agent = await requireHostedAgent(workspaceId, agentId);
  if (
    !previewsEnabled() ||
    agent.kind !== "hosted" ||
    agent.sandbox?.status !== "running" ||
    agent.sandbox.desktopViewable !== true
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "The desktop is not available right now",
    );
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CONTROL_LEASE_MS);
  // The row may not exist yet: create it free, then claim conditionally.
  await db.desktopSession.upsert({
    where: { agentId: agent.id },
    update: {},
    create: { agentId: agent.id, workspaceId },
    select: { id: true },
  });
  const { count } = await db.desktopSession.updateMany({
    where: {
      agentId: agent.id,
      OR: [
        { controllerUserId: null },
        { controlExpiresAt: { lte: now } },
        { controllerUserId: actor.userId },
      ],
    },
    data: {
      controllerUserId: actor.userId,
      controlTakenAt: now,
      controlExpiresAt: expiresAt,
      controlPushedAt: null,
    },
  });
  if (count === 0) {
    const holder = await db.desktopSession.findUnique({
      where: { agentId: agent.id },
      select: { controller: { select: { name: true, email: true } } },
    });
    throw new ServiceError(
      "CONFLICT",
      `${displayName(holder?.controller ?? null)} is in control`,
    );
  }
  signalWork();
  await recordAuditEvent({
    workspaceId,
    userId: actor.userId,
    userEmail: actor.userEmail,
    action: AUDIT_ACTIONS.CONTROL_TAKEN,
    service: AUDIT_SERVICES.DESKTOP,
    source: AUDIT_SOURCE.API,
    metadata: { agentId: agent.id },
  });
  return desktopFor(workspaceId, agentId, actor.userId);
};

/** The words the agent is resumed with when the hand-back finds it idle.
 * Platform-authored (no user bubble on the web, no attribution on Slack). */
const resumeMessage = (name: string): string =>
  `${name} took control of your desktop and is done. Look at the screen as it is now and continue.`;

/** How the person's control ended: they pressed Stop (`done`), or their
 * tab closed or went quiet and the sweep let go (`timeout`). */
type ReleaseOutcome = "done" | "timeout";

const noticeLine = (outcome: ReleaseOutcome, name: string): string => {
  switch (outcome) {
    case "done":
      return `${name} took over the desktop and is done.`;
    case "timeout":
      return `${name}'s control of the desktop timed out (the tab closed or went quiet).`;
  }
};

/** The notice when the hand-back's author cannot read the asking thread:
 * platform words only, no name (that person's own text). */
const anonymousNoticeLine = (outcome: ReleaseOutcome): string => {
  switch (outcome) {
    case "done":
      return "A teammate took over the desktop and handed it back. Ask again here if the step still needs you.";
    case "timeout":
      return "A teammate's control of the desktop timed out.";
  }
};

/**
 * Give the lease back (the person's Stop). The controller, or an org admin
 * taking it off a teammate (a stuck session, someone who left for the
 * day). The push to the sandbox rides the same NULLed clock as a take; the
 * supervisor then stops the input server and, when a turn is live, steers
 * it with the released words itself.
 *
 * A pending ask is settled by the FIRST hand-back after it: the notice
 * says who handed back, the cards settle, and the agent resumes. The
 * resume is a NEW turn only when nothing is live in the request's
 * conversation (a live turn gets the supervisor's steer, so a second nudge
 * would double it).
 */
export const releaseControl = async (
  workspaceId: string,
  agentId: string,
  actor: DesktopActor,
): Promise<DesktopState> => {
  const agent = await requireHostedAgent(workspaceId, agentId);
  const session = await db.desktopSession.findUnique({
    where: { agentId: agent.id },
    select: {
      ...sessionSelect,
      controller: { select: { name: true, email: true } },
    },
  });
  if (!session || !leaseLive(session)) {
    throw new ServiceError("CONFLICT", "Nobody is in control");
  }
  const byController = session.controllerUserId === actor.userId;
  if (
    !byController &&
    !(await userIsOrgAdmin(actor.userId, actor.organizationId))
  ) {
    throw new ServiceError(
      "FORBIDDEN",
      "Only the person in control, or an admin, can hand the desktop back.",
    );
  }
  // The privacy fence (conversation-service `visibleTo`): the ask may have
  // come from a person's PRIVATE direct thread, and the Computer section is
  // workspace-wide. Nothing that speaks for the person handing back (their
  // name, a resume turn carrying it) may enter a conversation they cannot
  // read: that would let any member wake someone else's session, history
  // and signed-in browser included, through the platform's direct-wake
  // door. They still hand back; the thread just hears it in fixed platform
  // words, and the agent there is not woken by them.
  const mayWriteThere = session.requestConversationId
    ? await canReadConversation(session.requestConversationId, actor.userId)
    : false;
  // The notice names the CONTROLLER (their profile name is their text), so
  // it is fenced on them.
  const controllerMayWriteThere =
    byController || !session.controllerUserId
      ? mayWriteThere
      : session.requestConversationId
        ? await canReadConversation(
            session.requestConversationId,
            session.controllerUserId,
          )
        : false;
  const released = await releaseLease(session, {
    outcome: "done",
    actorName: controllerMayWriteThere ? displayName(session.controller) : null,
    resume: byController && mayWriteThere,
  });
  await recordAuditEvent({
    workspaceId,
    userId: actor.userId,
    userEmail: actor.userEmail,
    action: AUDIT_ACTIONS.CONTROL_RELEASED,
    service: AUDIT_SERVICES.DESKTOP,
    source: AUDIT_SOURCE.API,
    metadata: {
      agentId: agent.id,
      ...(!byController && { controllerUserId: session.controllerUserId }),
      ...(released.resumed && { resumed: true }),
      ...(session.requestId &&
        !(mayWriteThere && controllerMayWriteThere) && {
          requestThreadPrivate: true,
        }),
    },
  });
  return desktopFor(workspaceId, agentId, actor.userId);
};

/** Whether this person may read the conversation: a group thread, or their
 * own direct thread. The same rule as conversation-service's `visibleTo`. */
const canReadConversation = async (
  conversationId: string,
  userId: string,
): Promise<boolean> =>
  (await db.conversation.count({
    where: {
      id: conversationId,
      OR: [{ direct: false }, { userId }],
    },
  })) > 0;

/**
 * The one release path, shared by the person's hand-back and the sweep:
 * clear the lease (fenced on the controller it was read with, so a release
 * racing a fresh take by someone else is a no-op), then settle the pending
 * ask, if any.
 */
const releaseLease = async (
  session: SessionRow,
  input: {
    outcome: ReleaseOutcome;
    /** Who handed back, for the thread's notice. Null when their name may
     * not enter the asking thread (they cannot read it): the notice is then
     * fixed platform text, naming nobody. */
    actorName: string | null;
    /** Whether the hand-back may resume the agent (an admin taking
     * control OFF someone is not the person who finished the step, and a
     * person who cannot read the asking thread never wakes it). */
    resume: boolean;
  },
): Promise<{ released: boolean; resumed: boolean }> => {
  if (session.controllerUserId === null)
    return { released: false, resumed: false };
  const { count } = await db.desktopSession.updateMany({
    where: {
      agentId: session.agentId,
      controllerUserId: session.controllerUserId,
      controlTakenAt: session.controlTakenAt,
      // A timeout releases only a lease STILL expired at write time: a
      // heartbeat landing between the sweep's read and this write renewed
      // it, and the renewed lease stands.
      ...(input.outcome === "timeout" && {
        controlExpiresAt: { lte: new Date() },
      }),
    },
    data: {
      controllerUserId: null,
      controlTakenAt: null,
      controlExpiresAt: null,
      controlPushedAt: null,
    },
  });
  if (count === 0) return { released: false, resumed: false };
  signalWork();
  if (!session.requestId) return { released: true, resumed: false };
  const settled = await settlePendingRequest(session, input);
  return { released: true, resumed: settled.resumed };
};

/**
 * Close the agent's open ask: the notice on the asking turn, the channel
 * cards rewritten, and, for a finished step, the agent resumed. The
 * request fields are cleared FIRST and conditionally (on the request id),
 * so a second hand-back or the sweep racing this one settles nothing
 * twice.
 */
const settlePendingRequest = async (
  session: SessionRow,
  input: {
    outcome: ReleaseOutcome | "expired";
    /** Null: the hand-back's author may not write into the asking thread. */
    actorName: string | null;
    resume: boolean;
  },
): Promise<{ settled: boolean; resumed: boolean }> => {
  const requestId = session.requestId;
  if (!requestId) return { settled: false, resumed: false };
  const { count } = await db.desktopSession.updateMany({
    where: { agentId: session.agentId, requestId },
    data: {
      requestId: null,
      requestReason: null,
      requestedAt: null,
      requestConversationId: null,
      requestTurnId: null,
      requestCardRefs: [],
    },
  });
  if (count === 0) return { settled: false, resumed: false };

  const reason = session.requestReason ?? "";
  await settleRequestCards(session, {
    reason,
    outcome: input.outcome,
    handledByName: input.outcome === "expired" ? null : input.actorName,
  });

  // The durable line on the asking turn (the model's next context reads
  // it too). Best-effort: the cleared request is already the truth.
  if (session.requestConversationId && session.requestTurnId) {
    const text =
      input.outcome === "expired"
        ? "Nobody took over the desktop in time. Ask again if it still matters."
        : input.actorName === null
          ? anonymousNoticeLine(input.outcome)
          : noticeLine(input.outcome, input.actorName);
    await writeConversationNotice({
      conversationId: session.requestConversationId,
      turnId: session.requestTurnId,
      level: input.outcome === "done" ? "info" : "warn",
      text,
      extra: { desktopRequest: { id: requestId, outcome: input.outcome } },
    }).catch((err: unknown) =>
      log.warn({ err, agentId: session.agentId }, "desktop notice failed"),
    );
  }

  if (input.outcome !== "done" || !input.resume || input.actorName === null)
    return { settled: true, resumed: false };
  return {
    settled: true,
    resumed: await resumeAgent(session, input.actorName),
  };
};

/**
 * Resume the agent after a finished step. A live turn in the request's
 * conversation already gets the supervisor's released steer on the control
 * flip, so this creates a turn ONLY when nothing is active there: the
 * idle case (the agent ended its reply after asking, as the fragment tells
 * it to). The turn is the platform's (`userId: null`), in the direct
 * thread the ask came from, through the direct-wake door that is reserved
 * for exactly this kind of platform resume. A conversation that is not
 * direct (a group thread) goes through the system door instead; both are
 * fenced to the agent's workspace.
 */
const resumeAgent = async (
  session: SessionRow,
  actorName: string,
): Promise<boolean> => {
  const conversationId = session.requestConversationId;
  if (!conversationId) return false;
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      direct: true,
      agent: { select: { id: true, workspaceId: true } },
    },
  });
  if (!conversation || conversation.agent.id !== session.agentId) return false;
  const live = await db.turn.findFirst({
    where: { conversationId, status: { in: [...ACTIVE_TURN_STATUSES] } },
    select: { id: true },
  });
  if (live) return false;
  try {
    await createTurn(
      conversation.agent.workspaceId,
      conversationId,
      resumeMessage(actorName),
      {
        source: DESKTOP_RESUME_SOURCE,
        userId: null,
        ...(conversation.direct && {
          directWake: { agentId: conversation.agent.id },
        }),
      },
    );
    return true;
  } catch (err) {
    // A turn landing in the same instant (a person typing "done" too) is
    // the right outcome, not a failure: the agent is awake either way.
    if (err instanceof ServiceError && err.code === "CONFLICT") return false;
    log.warn({ err, agentId: session.agentId }, "desktop resume turn failed");
    return false;
  }
};

/**
 * The takeover card's rendering per channel provider. Only Slack has one;
 * any other provider is dashboard-only, which is the durable surface anyway.
 */
const REQUEST_CARDS: Record<string, typeof slackDesktopRequestCard> = {
  slack: slackDesktopRequestCard,
};
const requestCardFor = (provider: string) => REQUEST_CARDS[provider] ?? null;

const settleRequestCards = async (
  session: SessionRow,
  input: {
    reason: string;
    outcome: "done" | "timeout" | "expired";
    handledByName: string | null;
  },
): Promise<void> => {
  const refs = cardRefsOf(session.requestCardRefs);
  if (refs.length === 0) return;
  const presence = await db.agentChannel.findFirst({
    where: { agentId: session.agentId, status: "active" },
    select: { provider: true, credentials: true },
  });
  const cardUi = presence ? requestCardFor(presence.provider) : null;
  if (!presence?.credentials || !cardUi) return;
  const credentialsJson = await getCrypto().decrypt(presence.credentials);
  for (const ref of refs) {
    try {
      await cardUi.settle({
        credentialsJson,
        channel: ref.channel,
        ts: ref.ts,
        reason: input.reason,
        outcome: input.outcome,
        handledByName: input.handledByName,
      });
    } catch (err) {
      log.warn(
        { agentId: session.agentId, err: String(err) },
        "desktop request card settle failed",
      );
    }
  }
};

// ── the agent's ask ────────────────────────────────────────────────────────

export interface TakeoverRequestOutcome {
  status: "requested";
  /** The dashboard's Computer section for this agent, deep-linked to the
   * request, which the agent may pass on. Null when the operator has not
   * configured a dashboard URL. */
  url: string | null;
}

/** The Computer section's URL, deep-linked to a request. Null when the
 * operator configured no dashboard URL (the card then has nowhere to
 * send a person; the in-app card still works). */
export const desktopUrl = (
  workspaceId: string,
  agentId: string,
  requestId?: string,
): string | null => {
  const appUrl = configuredAppUrl();
  if (!appUrl) return null;
  const url = new URL(
    `/w/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/computer`,
    appUrl,
  );
  if (requestId) url.searchParams.set("takeover", requestId);
  return url.toString();
};

/**
 * The `request_human_takeover` tool's handler. Hold-shaped: records the
 * ask, tells the person (the notice on the asking turn, a card to every
 * DM-reachable owner), and returns at once; the hand-back resumes the
 * agent later. A second ask while one is pending re-uses it (same id, same
 * URL), so a model repeating itself posts no second card.
 *
 * The claim is ONE conditional update (`requestId IS NULL`), the lease's
 * own fence: two asks racing (two conversations, a retried tool call)
 * both see a free row, but PostgreSQL re-checks the predicate after the
 * first commits, so exactly one claims it and every other caller gets the
 * winner's id. Only the winner writes the notice and posts the cards, so a
 * race never replaces the first ask's origin or orphans its cards.
 */
export const requestTakeover = async (input: {
  agentId: string;
  reason: string;
  originConversationId: string | null;
  originTurnId: string | null;
}): Promise<TakeoverRequestOutcome> => {
  if (!previewsEnabled()) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "The desktop is not available on this deployment",
    );
  }
  const agent = await db.agent.findUnique({
    where: { id: input.agentId },
    select: {
      id: true,
      name: true,
      kind: true,
      workspaceId: true,
      sandbox: { select: { status: true, desktopViewable: true } },
    },
  });
  if (
    !agent ||
    agent.kind !== "hosted" ||
    agent.sandbox?.status !== "running" ||
    agent.sandbox.desktopViewable !== true
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Your desktop is not viewable right now, so nobody can take it over",
    );
  }
  const reason = plainReason(input.reason).slice(0, MAX_REQUEST_REASON_CHARS);
  if (!reason) {
    throw new ServiceError("UNPROCESSABLE", "Say what the person should do");
  }

  const pending = () =>
    db.desktopSession.findUnique({
      where: { agentId: agent.id },
      select: { requestId: true },
    });
  const reuse = (requestId: string): TakeoverRequestOutcome => ({
    status: "requested",
    url: desktopUrl(agent.workspaceId, agent.id, requestId),
  });
  const existing = await pending();
  if (existing?.requestId) return reuse(existing.requestId);

  // The row may not exist yet: create it free (no request), then claim.
  if (!existing) {
    await db.desktopSession
      .upsert({
        where: { agentId: agent.id },
        update: {},
        create: { agentId: agent.id, workspaceId: agent.workspaceId },
        select: { id: true },
      })
      .catch((err: unknown) => {
        // Two first-touches racing on the unique agent key: the other one
        // created it, which is all this needed.
        if (
          !(err instanceof Prisma.PrismaClientKnownRequestError) ||
          err.code !== "P2002"
        )
          throw err;
      });
  }

  const requestId = randomUUID();
  const now = new Date();
  const { count } = await db.desktopSession.updateMany({
    where: { agentId: agent.id, requestId: null },
    data: {
      requestId,
      requestReason: reason,
      requestedAt: now,
      requestConversationId: input.originConversationId,
      requestTurnId: input.originTurnId,
      requestCardRefs: [],
    },
  });
  if (count === 0) {
    const winner = await pending();
    if (winner?.requestId) return reuse(winner.requestId);
    // Claimed and settled in between (a hand-back landed): rare enough
    // that saying so beats a retry loop; the agent may simply ask again.
    throw new ServiceError(
      "CONFLICT",
      "A takeover request was just settled; ask again if you still need one",
    );
  }
  const url = desktopUrl(agent.workspaceId, agent.id, requestId);

  if (input.originConversationId && input.originTurnId) {
    await writeConversationNotice({
      conversationId: input.originConversationId,
      turnId: input.originTurnId,
      level: "warn",
      text: `Needs you on the desktop: ${reason}`,
      extra: { desktopRequest: { id: requestId, outcome: "pending" } },
    }).catch((err: unknown) =>
      log.warn({ err, agentId: agent.id }, "desktop request notice failed"),
    );
  }
  await postRequestCards({
    agentId: agent.id,
    agentName: agent.name,
    workspaceId: agent.workspaceId,
    requestId,
    reason,
    url,
  });
  return { status: "requested", url };
};

/**
 * One card per DM-reachable owner, the action-approval shape: the refs
 * land on the session as each posts, so a crash midway leaves nothing to
 * post twice. No URL means no card: a button with nowhere to go is worse
 * than the in-app notice alone.
 */
const postRequestCards = async (input: {
  agentId: string;
  agentName: string;
  workspaceId: string;
  requestId: string;
  reason: string;
  url: string | null;
}): Promise<void> => {
  if (!input.url) return;
  const presence = await db.agentChannel.findFirst({
    where: { agentId: input.agentId, status: "active" },
    select: { provider: true, integrationId: true, credentials: true },
  });
  if (!presence?.credentials) return;
  const cardUi = requestCardFor(presence.provider);
  if (!cardUi) return;
  const owners = await dmReachableOwners(
    input.workspaceId,
    presence.integrationId,
  );
  if (owners.length === 0) return;
  const credentialsJson = await getCrypto().decrypt(presence.credentials);
  const posted: { channel: string; ts: string; userId: string }[] = [];
  for (const owner of owners) {
    try {
      const ref = await cardUi.post({
        credentialsJson,
        recipientExternalUserId: owner.externalUserId,
        agentName: input.agentName,
        reason: input.reason,
        url: input.url,
      });
      posted.push({ channel: ref.channel, ts: ref.ts, userId: owner.userId });
      await db.desktopSession.updateMany({
        where: { agentId: input.agentId, requestId: input.requestId },
        data: { requestCardRefs: posted.map((p) => ({ ...p })) },
      });
    } catch (err) {
      log.warn(
        { agentId: input.agentId, err: String(err) },
        "desktop request card post failed",
      );
    }
  }
};

// ── the relay's heartbeat and the sweep ────────────────────────────────────

/**
 * A desktop stream's beat (the relay's `/activity`, once at open and about
 * once a minute per viewer). Watching is NOT activity: a stream can sit
 * open in a tab nobody is looking at, and when its idle edge drops the
 * socket the client reconnects, so a forgotten tab would otherwise hold
 * the sandbox out of idle-stop for good (observed: one background tab,
 * a reconnect every two minutes, for hours). Driving IS activity: a beat
 * from the CONTROL host's stream renews its controller's lease (fenced on
 * the controller, so a stale viewer's beat after a demotion renews
 * nothing) and, only when that renewal landed, restarts the sandbox's idle
 * clock. A person at the mouse keeps the box up for exactly as long as
 * their input stream stays open.
 *
 * The host's role is part of the fence, not just the user: the controller
 * also watches through the VIEW host (the floating card, a second window),
 * and that stream must not keep the lease alive after their control
 * stream has closed.
 */
export const markDesktopActivity = async (
  agentId: string,
  userId: string | null,
  role: "view" | "control",
): Promise<void> => {
  if (!userId || role !== "control") return;
  const renewed = await db.desktopSession.updateMany({
    where: {
      agentId,
      controllerUserId: userId,
      controlExpiresAt: { gt: new Date() },
    },
    data: { controlExpiresAt: new Date(Date.now() + CONTROL_LEASE_MS) },
  });
  if (renewed.count === 0) return;
  await markSandboxEngaged(db, { agentId });
};

/**
 * Leases whose heartbeat stopped (a closed tab, a dead relay) and asks
 * nobody answered in a day. Rides the poll sweep (once a second, fleet
 * wide); both probes are indexed and empty almost always. The timed-out
 * lease is released through the same fenced path the person's Stop uses,
 * but the agent is NOT resumed (nobody finished the step): the notice
 * says what happened and the cards settle.
 */
export const sweepDesktopSessions = async (): Promise<{
  leasesReleased: number;
  requestsExpired: number;
}> => {
  const now = new Date();
  const stale = await db.desktopSession.findMany({
    where: { controllerUserId: { not: null }, controlExpiresAt: { lte: now } },
    select: {
      ...sessionSelect,
      controller: { select: { name: true, email: true } },
    },
    take: 50,
  });
  let leasesReleased = 0;
  for (const session of stale) {
    // The timeout notice names the controller: only where they may read
    // the asking thread (see releaseControl's fence).
    const named =
      session.requestConversationId && session.controllerUserId
        ? await canReadConversation(
            session.requestConversationId,
            session.controllerUserId,
          )
        : false;
    const released = await releaseLease(session, {
      outcome: "timeout",
      actorName: named ? displayName(session.controller) : null,
      resume: false,
    });
    if (released.released) leasesReleased += 1;
  }

  const expired = await db.desktopSession.findMany({
    where: {
      requestId: { not: null },
      requestedAt: { lte: new Date(now.getTime() - REQUEST_MAX_AGE_MS) },
    },
    select: sessionSelect,
    take: 50,
  });
  let requestsExpired = 0;
  for (const session of expired) {
    const settled = await settlePendingRequest(session, {
      outcome: "expired",
      actorName: "",
      resume: false,
    });
    if (settled.settled) requestsExpired += 1;
  }
  return { leasesReleased, requestsExpired };
};
