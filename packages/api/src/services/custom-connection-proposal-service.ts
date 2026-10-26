import { db } from "@onecli/db";
import type { Prisma } from "@onecli/db";
import { logger } from "../lib/logger";
import {
  CUSTOM_CONNECTION_ACTION,
  customConnectionProposalSchema,
  type CustomConnectionProposal,
} from "../validations/custom-connection";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  withAudit,
} from "./audit-service";
import {
  registerActionHandler,
  requestActionApproval,
  type ApprovedAction,
} from "./channels/action-approval-service";
import {
  checkProposalHost,
  proposalRefusalMessage,
} from "./custom-connection-policy";
import { ServiceError } from "./errors";
import { setSecretGrant } from "./grants-service";
import { createSecret } from "./secret-service";

const log = logger.child({ service: "custom-connection-proposal" });

/**
 * AGENT-PROPOSED custom connections (stage 2): the agent researches a
 * service with no catalog app and proposes WHERE and HOW a key is injected;
 * a human reviews that in the chat card and types the key. The design laws:
 *
 * - The agent never holds, sends or saves the key. The proposal schema has no
 *   value field; the key exists only in the approve route's request body and
 *   in memory for the handler call (`decideActionApproval`'s `secretValue`).
 * - Only a human APPROVE with the key creates a secret. The action registers
 *   `requiresSecretValue`, so the generic decide doors (dashboard decision
 *   route, Slack click) can reject it but never approve it.
 * - The payload is immutable and re-validated at approve time (schema +
 *   host policy), so a policy added after the ask still wins.
 * - The new secret is granted to the PROPOSING agent only. A custom secret
 *   is granted to no agent on creation, so the explicit `setSecretGrant`
 *   below is the only grant written.
 */

/**
 * The chat message that resumes the agent once the person approves. Fixed
 * platform text: it shows in the transcript as the APPROVER's line, so it
 * must carry nothing the agent wrote (an agent-chosen name could smuggle an
 * instruction in the human's voice). The agent learns which connection from
 * the outcome notice and `list_apps`. Never carries the key.
 */
export const RESUME_AFTER_CUSTOM_CONNECTION_MESSAGE =
  "Custom connection approved and details provided.";

/** The card's one-liner: platform text around cleaned fields. */
const summaryFor = (p: CustomConnectionProposal): string =>
  `connect "${p.name}" (key sent to ${p.hostPattern}${p.pathPattern ?? ""} in the ${p.headerName} header)`;

/** Validate a proposal fully (shape + host policy). Throws a ServiceError
 * carrying the model/user-facing words. */
const validateProposal = (raw: unknown): CustomConnectionProposal => {
  const parsed = customConnectionProposalSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw new ServiceError(
      "UNPROCESSABLE",
      `${field ? `${field}: ` : ""}${issue?.message ?? "Invalid proposal"}`,
    );
  }
  const refusal = checkProposalHost(parsed.data);
  if (refusal) {
    throw new ServiceError("UNPROCESSABLE", proposalRefusalMessage(refusal));
  }
  return parsed.data;
};

/** The platform tool's door: validate, then hold for a human. */
export const proposeCustomConnection = async (input: {
  agentId: string;
  conversationId: string | null;
  originTurnId: string | null;
  args: unknown;
}): Promise<{ id: string; proposal: CustomConnectionProposal }> => {
  const proposal = validateProposal(input.args);
  const held = await requestActionApproval({
    agentId: input.agentId,
    conversationId: input.conversationId,
    originTurnId: input.originTurnId,
    action: CUSTOM_CONNECTION_ACTION,
    // Every field is non-secret by construction (no value field exists).
    payload: proposal satisfies Prisma.InputJsonValue,
    summary: summaryFor(proposal),
  });
  return { id: held.id, proposal };
};

/**
 * The approved half, run by `decideActionApproval` from the frozen row with
 * the approver's key in memory. Returns the platform note the outcome line
 * carries to the person and the model.
 */
const executeCustomConnection = async (
  approval: ApprovedAction,
  context: { secretValue?: string },
): Promise<string> => {
  const value = context.secretValue?.trim();
  if (!value) throw new Error("no key was provided");
  const proposal = validateProposal(approval.payload);

  const agent = await db.agent.findUniqueOrThrow({
    where: { id: approval.agentId },
    select: {
      workspaceId: true,
      workspace: { select: { organizationId: true } },
    },
  });
  const scope = {
    workspaceId: agent.workspaceId,
    organizationId: agent.workspace.organizationId,
  };
  const decider = await db.user.findUniqueOrThrow({
    where: { id: approval.decidedByUserId },
    select: { email: true },
  });
  const audit = {
    workspaceId: scope.workspaceId,
    userId: approval.decidedByUserId,
    userEmail: decider.email,
    source: AUDIT_SOURCE.API,
  };

  // Both writes go through `withAudit`, which also flushes the gateway cache
  // by the workspace's API key (the approve route flushes again by the
  // approver's session). Ids and the host only: never the value, the format
  // or the payload.
  const secret = await withAudit(
    () =>
      createSecret(
        { workspaceId: scope.workspaceId },
        {
          name: proposal.name,
          type: "generic",
          valueSource: "inline",
          value,
          hostPattern: proposal.hostPattern,
          ...(proposal.pathPattern && { pathPattern: proposal.pathPattern }),
          injectionConfig: {
            headerName: proposal.headerName,
            valueFormat: proposal.valueFormat,
          },
        },
        approval.decidedByUserId,
      ),
    (created) => ({
      ...audit,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.SECRET,
      metadata: {
        secretId: created.id,
        agentId: approval.agentId,
        approvalId: approval.id,
        host: proposal.hostPattern,
        origin: "agent-proposal",
      },
    }),
  );

  // The proposer only, with the same single allow rule the agent page's
  // toggle writes. A failure here fails the approval loudly: the secret
  // exists, so the outcome line tells the person where to switch it on.
  try {
    await withAudit(
      () =>
        setSecretGrant(
          scope,
          approval.agentId,
          secret.id,
          approval.decidedByUserId,
        ),
      (r) => ({
        ...audit,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.GRANT,
        metadata: {
          agentId: approval.agentId,
          secretId: secret.id,
          approvalId: approval.id,
          changed: r.changed,
          ruleIds: r.ruleIds,
        },
      }),
    );
  } catch (err) {
    log.warn(
      { approvalId: approval.id, secretId: secret.id, err: String(err) },
      "custom connection saved but its grant failed",
    );
    throw new Error(
      `the connection "${proposal.name}" was saved but could not be switched on for the agent; turn it on from the agent's Custom tab`,
    );
  }

  return `Connected as "${proposal.name}" (id ${secret.id}). Test it with one read-only GET to ${proposal.hostPattern} before anything else.`;
};

registerActionHandler(CUSTOM_CONNECTION_ACTION, executeCustomConnection, {
  requiresSecretValue: true,
});
