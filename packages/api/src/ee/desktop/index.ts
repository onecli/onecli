import { Prisma } from "@onecli/db";
import { MAX_DESKTOP_CONTROLLER_NAME_CHARS } from "@onecli/agent-protocol";
import { cleanLabel } from "@onecli/agent-protocol/text";
import { PREVIEW_DOMAIN } from "../../lib/env";
import { previewsEnabled } from "../../lib/preview-availability";
import type {
  AgentDesktop,
  AgentDesktopPush,
} from "../../providers/hooks/agent-desktop";
import { ServiceError } from "../../services/errors";
import {
  authorizeHost,
  mintPreviewTicket,
} from "../../services/sandbox-port-service";
import { channelHeldBy } from "../../services/runner-replica-fence";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../../services/audit-service";
import {
  markDesktopActivity,
  requestTakeover,
  sweepDesktopSessions,
  takeoverArgsSchema,
} from "./service";

/**
 * Pushes per poll, like home syncs: a person's take or release is rare, and
 * the claim is fenced per sandbox, so a small bound never starves anyone.
 */
const PUSH_LIMIT = 3;

interface PushRow {
  sandbox_id: string;
  /** Non-null while a lease is live. */
  controller_user_id: string | null;
  control_expires_at: Date | null;
  controller_name: string | null;
  controller_email: string | null;
}

/**
 * Controller pushes: `control_pushed_at` is the pacing clock the way
 * `home_sync_claimed_at` is for syncs. NULL = a change the sandbox has not
 * seen; the claim stamps now() and a change after the claim (take,
 * release, expiry) resets it to NULL. There is no ack: the supervisor is
 * idempotent and its viewability report is its own, so a push lost with
 * its channel is re-armed by the next change. "Controlled" is decided
 * HERE from the lease clock, so a lease that expired between the sweep and
 * this poll pushes as released. The runner capability gate keeps an older
 * runner's batch free of a kind it cannot parse.
 */
const claimPushes = async (
  tx: Prisma.TransactionClient,
  runnerId: string,
  replicaId: string | undefined,
): Promise<AgentDesktopPush[]> => {
  const rows = await tx.$queryRaw<PushRow[]>`
    WITH claimed AS (
      SELECT d.id, d.controller_user_id, s.id AS sandbox_id
      FROM desktop_sessions d
      JOIN sandboxes s ON s.agent_id = d.agent_id
      JOIN runners r ON r.id = s.runner_id
      WHERE s.runner_id = ${runnerId}
        ${channelHeldBy(replicaId)}
        AND s.status = 'running'
        AND d.control_pushed_at IS NULL
        AND (r.capabilities->>'desktopControl')::boolean IS TRUE
      ORDER BY d.updated_at ASC
      LIMIT ${PUSH_LIMIT}
      FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE desktop_sessions d SET control_pushed_at = now()
    FROM claimed c
    LEFT JOIN users u ON u.id = c.controller_user_id
    WHERE d.id = c.id
    RETURNING c.sandbox_id,
      d.controller_user_id,
      d.control_expires_at,
      u.name AS controller_name,
      u.email AS controller_email
  `;
  return rows.map((row): AgentDesktopPush => {
    const controlled =
      row.controller_user_id !== null &&
      row.control_expires_at !== null &&
      row.control_expires_at.getTime() > Date.now();
    // Bounded to the wire's cap HERE, at the one place the name enters a
    // poll item: the runner parses a poll batch all-or-nothing, so a
    // profile name over the cap (names allow 255) would fail the whole
    // batch and lose every item claimed beside it, other tenants' turns,
    // aborts and steers included. Control characters go with it.
    const controllerName = cleanLabel(
      row.controller_name || row.controller_email || "",
      MAX_DESKTOP_CONTROLLER_NAME_CHARS,
    );
    return {
      kind: "desktop.control",
      sandboxId: row.sandbox_id,
      controlled,
      ...(controlled && controllerName && { controllerName }),
    };
  });
};

/**
 * The page's stream credential: the same signed, host-bound, 60 s ticket
 * the preview login handoff mints, handed to the page instead of a
 * redirect. Minted only for a desktop host this person may use right now
 * (for the control host that includes holding the lease), so a ticket for
 * the control host is one the lease holder asked for.
 */
const mintTicket: AgentDesktop["mintTicket"] = async (viewer) => {
  const host = viewer.host.toLowerCase();
  if (!previewsEnabled() || !host.endsWith(`.${PREVIEW_DOMAIN}`)) {
    throw new ServiceError("NOT_FOUND", "Unknown desktop");
  }
  const target = await authorizeHost(viewer.userId, host);
  if (!target || target.kind !== "desktop") {
    throw new ServiceError(
      "FORBIDDEN",
      "You don't have access to this desktop",
    );
  }
  const ticket = mintPreviewTicket(host, viewer.userId);
  // Opening the view is an access event like opening a preview or a
  // shell. Opening the input stream is already audited as CONTROL_TAKEN
  // (the lease), so the view ticket is the one row here.
  if (target.desktop.role === "view") {
    await recordAuditEvent({
      workspaceId: target.workspaceId,
      userId: viewer.userId,
      userEmail: viewer.userEmail,
      action: AUDIT_ACTIONS.SESSION_OPEN,
      service: AUDIT_SERVICES.DESKTOP,
      source: AUDIT_SOURCE.API,
      metadata: { agentId: target.agentId, hostname: host },
    });
  }
  return { ticket };
};

/** `request_human_takeover`: ask a person to take the screen for a step. */
const callTool: AgentDesktop["callTool"] = async (input) => {
  const args = takeoverArgsSchema.safeParse(input.args);
  if (!args.success) {
    return {
      ok: false,
      error: args.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const outcome = await requestTakeover({
    agentId: input.agentId,
    reason: args.data.reason,
    originConversationId: input.originConversationId,
    originTurnId: input.originTurnId,
  });
  return {
    ok: true,
    result: {
      status: outcome.status,
      ...(outcome.url && { url: outcome.url }),
      note: "The person has been asked. End your reply now and stop acting on that page; you will be resumed when they hand the screen back.",
    },
  };
};

/** The hosted platform's agent desktop, injected at boot (edition-defaults). */
export const eeAgentDesktop: AgentDesktop = {
  sweep: async () => {
    await sweepDesktopSessions();
  },
  claimPushes,
  markActivity: markDesktopActivity,
  mintTicket,
  callTool,
};
