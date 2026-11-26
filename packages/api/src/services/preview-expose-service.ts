import { db } from "@onecli/db";
import { z } from "zod";
import { MAX_PROCESS_COMMAND_CHARS } from "@onecli/agent-protocol";
import { ServiceError } from "./errors";
import {
  registerActionHandler,
  requestActionApproval,
} from "./channels/action-approval-service";
import {
  RESERVED_PORTS,
  previewHostname,
  reserveSandboxPortSlug,
  setPreviewStartCommand,
  shareSandboxPort,
} from "./sandbox-port-service";
import { previewsEnabled } from "../lib/preview-availability";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "./audit-service";

/**
 * `preview_expose` — the agent ASKS for a preview URL for one of its ports
 * (plans/sandbox-ports.md §8). A human always decides (no auto-approval in
 * v1): the ask becomes a one-shot ActionApproval, and only the approval
 * handler creates the share. The tool never shares anything on its own.
 *
 * Already shared → the URL comes back immediately (nothing to approve: a
 * human already decided). Pending ask for the same port → the same hold is
 * reported, never a second card.
 */

export const PREVIEW_EXPOSE_ACTION = "sandbox.preview_expose";

export const previewExposeArgsSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    reason: z.string().trim().min(1).max(300).optional(),
    // The command that brings the app back after a sleep, run by the
    // supervisor as the agent's own background process on a wake a preview
    // hit caused. Stored on the port row from the ask onward (a live share
    // takes it too), so the link keeps working without the agent. Bounded
    // like a process_start command; never interpreted by the control plane.
    startCommand: z
      .string()
      .trim()
      .min(1)
      .max(MAX_PROCESS_COMMAND_CHARS)
      .optional(),
  })
  .strict();

const payloadSchema = z.object({ port: z.number().int() });

/**
 * The model's reason, made inert for the approval card: the only link a
 * human should ever see there is the platform's own preview URL. URLs and
 * bare domains lose their scheme/dots, and chat-markup characters go, so a
 * prompt-injected agent can't render "approve, then sign in at evil.example"
 * as a clickable or bold call to action (Slack renders summaries as mrkdwn).
 */
export const plainReason = (raw: string): string =>
  raw
    .replace(/\p{Cc}/gu, " ")
    .replace(/[*_~`<>|[\]]/g, "")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\//gi, "")
    .replace(/([a-z0-9-])\.(?=[a-z0-9-]{2,})/gi, "$1\u2024")
    .replace(/\s+/g, " ")
    .trim();

export type PreviewExposeOutcome =
  | { kind: "live"; port: number; url: string }
  | { kind: "held"; port: number; url: string };

export const requestPreviewExpose = async (input: {
  agentId: string;
  port: number;
  reason?: string;
  startCommand?: string;
  originConversationId: string | null;
  originTurnId: string | null;
}): Promise<PreviewExposeOutcome> => {
  if (!previewsEnabled()) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Previews are not enabled on this deployment",
    );
  }
  if (RESERVED_PORTS.has(input.port)) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Port ${input.port} can't be previewed`,
    );
  }
  const agent = await db.agent.findUnique({
    where: { id: input.agentId },
    select: { kind: true, name: true },
  });
  if (!agent || agent.kind !== "hosted") {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Previews are only available for hosted agents",
    );
  }

  const share = await db.sandboxPort.findUnique({
    where: { agentId_port: { agentId: input.agentId, port: input.port } },
    select: { slug: true, revokedAt: true },
  });
  if (share && !share.revokedAt) {
    // A repeated ask for a live share is how the agent (re)states the
    // relaunch command: the one thing about a share it owns.
    if (input.startCommand) {
      await setPreviewStartCommand(
        input.agentId,
        input.port,
        input.startCommand,
      );
    }
    return {
      kind: "live",
      port: input.port,
      url: `https://${previewHostname(share.slug)}`,
    };
  }
  // Reserve the hostname now (inert until approved) so the agent can
  // configure its app for the final URL while the human decides, and the
  // approver sees exactly which link they are opening. The relaunch command
  // rides on the same row from here: the approval revives it unchanged.
  const slug = await reserveSandboxPortSlug(input.agentId, input.port);
  if (input.startCommand) {
    await setPreviewStartCommand(input.agentId, input.port, input.startCommand);
  }
  const url = `https://${previewHostname(slug)}`;

  // One open ask per port: a retrying model must not stack cards.
  const pending = await db.actionApproval.findMany({
    where: {
      agentId: input.agentId,
      action: PREVIEW_EXPOSE_ACTION,
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    select: { payload: true },
  });
  const alreadyAsked = pending.some(
    (row) => payloadSchema.safeParse(row.payload).data?.port === input.port,
  );
  if (!alreadyAsked) {
    // Platform-composed summary: the port is a validated int; the reason is
    // model text, so it rides in quotes and the approval service clamps it.
    const reason = input.reason ? ` ("${plainReason(input.reason)}")` : "";
    await requestActionApproval({
      agentId: input.agentId,
      conversationId: input.originConversationId,
      originTurnId: input.originTurnId,
      action: PREVIEW_EXPOSE_ACTION,
      payload: { port: input.port },
      summary: `${agent.name} wants a private preview link for port ${input.port}${reason}: ${url} (only signed-in workspace members can open it)`,
    });
  }
  return { kind: "held", port: input.port, url };
};

/** Approve = share. Fenced on the approval's own agent; the decider is the
 * share's creator (the human who said yes). */
registerActionHandler(PREVIEW_EXPOSE_ACTION, async (approval) => {
  const { port } = payloadSchema.parse(approval.payload);
  const row = await db.actionApproval.findUnique({
    where: { id: approval.id },
    select: {
      decidedByUserId: true,
      agent: { select: { workspaceId: true } },
    },
  });
  if (!row) throw new Error("the approval no longer exists");
  const share = await shareSandboxPort({
    workspaceId: row.agent.workspaceId,
    agentId: approval.agentId,
    port,
    userId: row.decidedByUserId,
    approvalId: approval.id,
  });
  if (row.decidedByUserId) {
    const decider = await db.user.findUnique({
      where: { id: row.decidedByUserId },
      select: { email: true },
    });
    await recordAuditEvent({
      workspaceId: row.agent.workspaceId,
      userId: row.decidedByUserId,
      userEmail: decider?.email ?? "",
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.PREVIEW,
      source: AUDIT_SOURCE.APP,
      metadata: {
        agentId: approval.agentId,
        port: String(port),
        hostname: share.hostname,
        approvalId: approval.id,
      },
    });
  }
});
