import { db } from "@onecli/db";
import { APPROVAL_GROUP_MAX_IDS } from "@onecli/channels";
import { getCrypto } from "../../providers";
import { logger } from "../../lib/logger";
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
  settleToolApprovalCard,
} from "./channel-adapter-service";
import {
  decideApprovalAtGateway,
  type GatewayDecisionResult,
} from "./gateway-approvals";
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

/** Gateway decides in flight at once for one grouped click. */
const GATEWAY_CONCURRENCY = 10;

const log = logger.child({ service: "channel-approval" });

/** One id's answer in a grouped click: the gateway's, or `error` when the
 *  call itself failed (the approval stays pending). */
type GroupOutcome = GatewayDecisionResult["outcome"] | "error";

export type ChannelGroupDecisionResult =
  | {
      kind: "decided";
      decidedByName: string;
      /** Ids the gateway accepted the decision for. */
      decided: string[];
      /** Ids already settled (expired, decided elsewhere). */
      alreadySettled: string[];
      /** Ids the gateway errored on: still pending, so the card keeps them. */
      failed: string[];
    }
  | { kind: "refused"; message: string }
  | { kind: "unavailable"; message: string };

/**
 * The presence and the AUTHORIZED clicker for a channel click, or a refusal.
 * Both the single and the grouped decide pass through this one fence, so
 * the authorization rule can't drift between them. A first-time clicker has
 * no link yet: the provider's own email lookup lets the lazy verified-email
 * match run; a failed lookup just means "not linked".
 */
const resolveClicker = async (
  presenceId: string,
  clickerExternalUserId: string,
) => {
  const presence = await db.agentChannel.findUnique({
    where: { id: presenceId },
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
    return {
      kind: "refused" as const,
      message: "This agent is no longer attached.",
    };
  }
  let email: string | undefined;
  const existingLink = await db.channelUserLink.findUnique({
    where: {
      integrationId_externalUserId: {
        integrationId: presence.integrationId,
        externalUserId: clickerExternalUserId,
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
      externalUserId: clickerExternalUserId,
    });
  }
  const clicker = await authorizeChannelUser(
    presence.integrationId,
    presence.agent.workspace.organizationId,
    presence.agent.workspace,
    clickerExternalUserId,
    email,
  );
  if (!clicker) {
    return {
      kind: "refused" as const,
      message:
        "Only workspace members can decide this. Ask an admin for access, or decide it from the dashboard.",
    };
  }
  return { kind: "ok" as const, presence, clicker };
};

/**
 * A grouped card's Approve all / Deny all (or one row), from a channel. The
 * same trust shape as the single decide, applied to every id:
 *
 * - the clicker is authorized ONCE as a workspace member, before anything;
 * - EVERY id must be a card THIS presence posted (a `ToolApprovalCard` row
 *   on `presenceId`). An id this presence never carried is refused for the
 *   whole click, never silently skipped, so a forged payload naming another
 *   agent's or workspace's approval decides nothing;
 * - each id is then decided at the gateway on its own with the presence's
 *   service key (the gateway re-fences each to the key's workspace), and
 *   every decision the gateway accepted gets its own audit row naming the
 *   clicker, even when another id in the same click was refused.
 */
export const decideApprovalsFromChannel = async (input: {
  presenceId: string;
  approvalIds: string[];
  decision: "approve" | "deny";
  clickerExternalUserId: string;
}): Promise<ChannelGroupDecisionResult> => {
  // The HTTP arm reaches here with ids decoded from a signed payload, the
  // socket arm with a validated body: this is the one cap both pass.
  const ids = [...new Set(input.approvalIds)];
  if (ids.length === 0 || ids.length > APPROVAL_GROUP_MAX_IDS) {
    return { kind: "refused", message: "That card can't be decided at once." };
  }
  const resolved = await resolveClicker(
    input.presenceId,
    input.clickerExternalUserId,
  );
  if (resolved.kind === "refused") return resolved;
  const { presence, clicker } = resolved;

  // The fence: every id must be one of THIS presence's posted cards.
  const owned = await db.toolApprovalCard.count({
    where: { approvalId: { in: ids }, agentChannelId: presence.id },
  });
  if (owned !== ids.length) {
    return {
      kind: "refused",
      message:
        "Some of these requests aren't on this card. Decide them from the dashboard.",
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

  const outcomes: { approvalId: string; outcome: GroupOutcome }[] = [];
  for (let i = 0; i < ids.length; i += GATEWAY_CONCURRENCY) {
    const batch = ids.slice(i, i + GATEWAY_CONCURRENCY);
    outcomes.push(
      ...(await Promise.all(
        batch.map(async (approvalId) => ({
          approvalId,
          outcome: await decideApprovalAtGateway({
            serviceKey,
            approvalId,
            decision: input.decision,
          }).then(
            (r): GroupOutcome => r.outcome,
            (err: unknown): GroupOutcome => {
              log.warn(
                { approvalId, presenceId: presence.id, err: String(err) },
                "grouped decide: gateway call failed; the row stays pending",
              );
              return "error";
            },
          ),
        })),
      )),
    );
  }
  const idsWith = (...kinds: GroupOutcome[]) =>
    outcomes.filter((o) => kinds.includes(o.outcome)).map((o) => o.approvalId);
  const decided = idsWith("decided");
  const alreadySettled = idsWith("not_found", "already_settled");

  // Record what happened before anything else can return: a decision the
  // gateway accepted stands, so its card settles and the clicker is named.
  // The write carries the same presence fence as the read above.
  await db.toolApprovalCard.updateMany({
    where: {
      approvalId: { in: [...decided, ...alreadySettled] },
      agentChannelId: presence.id,
    },
    data: { state: "decided" },
  });
  const decidedBy = await db.user.findUnique({
    where: { id: clicker.userId },
    select: { name: true, email: true },
  });
  await Promise.all(
    decided.map((approvalId) =>
      recordAuditEvent({
        workspaceId: presence.agent.workspaceId,
        userId: clicker.userId,
        userEmail: decidedBy?.email ?? "",
        action:
          input.decision === "approve"
            ? AUDIT_ACTIONS.APPROVE
            : AUDIT_ACTIONS.DENY,
        service: AUDIT_SERVICES.CHANNEL,
        status: AUDIT_STATUS.SUCCESS,
        source: AUDIT_SOURCE.API,
        metadata: {
          approvalId,
          agentId: presence.agent.id,
          presenceId: presence.id,
          decision: input.decision,
          groupSize: ids.length,
        },
      }),
    ),
  );

  if (idsWith("unauthorized").length > 0) {
    await reportApprovalAuth(presence.id, false);
    return {
      kind: "unavailable",
      message:
        "Approvals need re-attaching for this agent (its service key was refused). Decide it from the dashboard.",
    };
  }
  return {
    kind: "decided",
    decidedByName: decidedBy?.name || decidedBy?.email || "a teammate",
    decided,
    alreadySettled,
    // Left pending: the card keeps the row and a click can retry.
    failed: idsWith("error"),
  };
};

export const decideApprovalFromChannel = async (input: {
  presenceId: string;
  approvalId: string;
  decision: "approve" | "deny";
  clickerExternalUserId: string;
}): Promise<ChannelDecisionResult> => {
  const resolved = await resolveClicker(
    input.presenceId,
    input.clickerExternalUserId,
  );
  if (resolved.kind === "refused") return resolved;
  const { presence, clicker } = resolved;

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
    await settleToolApprovalCard(input.approvalId, "decided");
    return { kind: "already_settled" };
  }

  await settleToolApprovalCard(input.approvalId, "decided");

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
