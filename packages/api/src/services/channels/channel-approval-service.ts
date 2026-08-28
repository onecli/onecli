import { db } from "@onecli/db";
import { getCrypto } from "../../providers";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  AUDIT_STATUS,
  recordAuditEvent,
} from "../audit-service";
import { authorizeChannelUser } from "./channel-ingestion-service";
import {
  reportApprovalAuth,
  settleApprovalPrompt,
} from "./channel-adapter-service";
import { decideApprovalAtGateway } from "./gateway-approvals";
import { channelProvider } from "./registry";
import type { ChannelProviderId } from "./types";

/**
 * One decide flow for BOTH transports: the events arm's interactivity route
 * and the socket adapter's forwarded button click land here. The clicker is
 * authorized as a platform user with workspace access BEFORE the gateway is
 * asked anything, the decision is made with the presence's service key, and
 * the audit row carries the REAL human — the gateway's own `approved_by` can
 * only name the key's owner, so this row is where per-clicker attribution
 * lives (recorded design note; a gateway assertion header is a follow-up).
 */

export type ChannelDecisionResult =
  | { kind: "decided"; decidedByName: string }
  | { kind: "already_settled" }
  | { kind: "refused"; message: string }
  | { kind: "unavailable"; message: string };

export const decideApprovalFromChannel = async (input: {
  presenceId: string;
  approvalId: string;
  decision: "approve" | "deny";
  clickerExternalUserId: string;
}): Promise<ChannelDecisionResult> => {
  const presence = await db.agentChannel.findUnique({
    where: { id: input.presenceId },
    select: {
      id: true,
      provider: true,
      integrationId: true,
      credentials: true,
      apiKey: { select: { key: true } },
      agent: {
        select: {
          id: true,
          workspaceId: true,
          workspace: { select: { id: true, organizationId: true } },
        },
      },
    },
  });
  if (!presence) {
    return { kind: "refused", message: "This agent is no longer attached." };
  }

  // Resolve the clicker. A first-time clicker has no link yet — the
  // provider's own email lookup lets the lazy verified-email match run; a
  // failed lookup just means "not linked".
  let email: string | undefined;
  const existingLink = await db.channelUserLink.findUnique({
    where: {
      integrationId_externalUserId: {
        integrationId: presence.integrationId,
        externalUserId: input.clickerExternalUserId,
      },
    },
    select: { id: true },
  });
  if (!existingLink) {
    const credentialsJson = presence.credentials
      ? await getCrypto().decrypt(presence.credentials)
      : null;
    email = await channelProvider(
      presence.provider as ChannelProviderId,
    ).lookupUserEmail({
      credentialsJson,
      externalUserId: input.clickerExternalUserId,
    });
  }

  const clicker = await authorizeChannelUser(
    presence.integrationId,
    presence.agent.workspace.organizationId,
    presence.agent.workspace,
    input.clickerExternalUserId,
    email,
  );
  if (!clicker) {
    return {
      kind: "refused",
      message:
        "Only workspace members can decide this. Ask an admin for access, or decide it from the dashboard.",
    };
  }

  const serviceKey = presence.apiKey?.key;
  if (!serviceKey) {
    return {
      kind: "unavailable",
      message:
        "Approvals aren't wired up for this agent right now. Decide it from the dashboard.",
    };
  }

  const result = await decideApprovalAtGateway({
    serviceKey,
    approvalId: input.approvalId,
    decision: input.decision,
  });

  if (result.outcome === "unauthorized") {
    // The key's owner lost workspace access — flip the presence so the
    // dashboard names the fix, and tell the clicker something actionable.
    await reportApprovalAuth(presence.id, false);
    return {
      kind: "unavailable",
      message:
        "Approvals need re-attaching for this agent (its service key was refused). Decide it from the dashboard.",
    };
  }
  if (result.outcome === "not_found" || result.outcome === "already_settled") {
    await settleApprovalPrompt(input.approvalId, "decided");
    return { kind: "already_settled" };
  }

  await settleApprovalPrompt(input.approvalId, "decided");

  const decidedBy = await db.user.findUnique({
    where: { id: clicker.userId },
    select: { name: true, email: true },
  });

  // THE attribution row: the gateway logged its key owner; this names the
  // human who clicked.
  await recordAuditEvent({
    workspaceId: presence.agent.workspaceId,
    userId: clicker.userId,
    userEmail: decidedBy?.email ?? "",
    action:
      input.decision === "approve" ? AUDIT_ACTIONS.APPROVE : AUDIT_ACTIONS.DENY,
    service: AUDIT_SERVICES.CHANNEL,
    status: AUDIT_STATUS.SUCCESS,
    source: AUDIT_SOURCE.API,
    metadata: {
      approvalId: input.approvalId,
      agentId: presence.agent.id,
      presenceId: presence.id,
      decision: input.decision,
    },
  });

  return {
    kind: "decided",
    decidedByName: decidedBy?.name || decidedBy?.email || "a teammate",
  };
};
