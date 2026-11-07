import { logger } from "../lib/logger";
import { approvalResultLine } from "../lib/approval-result";
import { listApprovalOutcomes } from "./approval-outcome-service";
import { rewriteGatewayApprovalCards } from "./channels/gateway-approval-card";

const log = logger.child({ component: "approval-result-followup" });

/** How long the upstream has to answer an approved request before the card
 * stops waiting for its result: a card that changes minutes after the click
 * reads as noise, not news. */
const WAIT_MS = 30_000;
const POLL_MS = 1_500;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/**
 * After a person approves gateway requests from a channel card, wait (off
 * the click's path) for what the upstream actually did, and when it did NOT
 * do what was approved, rewrite the card to say so:
 *
 *   ✅ Approved by Alex Kim · ⚠️ Created 0 of 9 · BillingCountry: …
 *
 * so the agent's fixed resend reads as the fix it is, not a mystery second
 * approval. A success leaves the card as the click wrote
 * it. Fenced like the outcome read itself: the caller's workspace and agent.
 */
export const followApprovedResults = (input: {
  workspaceId: string;
  organizationId: string;
  agentId: string;
  approvalIds: string[];
  decidedByName: string;
}): void => {
  if (input.approvalIds.length === 0) return;
  void (async () => {
    const deadline = Date.now() + WAIT_MS;
    const open = new Set(input.approvalIds);
    while (open.size > 0 && Date.now() < deadline) {
      await sleep(POLL_MS);
      const outcomes = await listApprovalOutcomes({
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        agentId: input.agentId,
        approvalIds: [...open],
      });
      const failed = new Map<string, string>();
      for (const o of outcomes) {
        if (o.outcome !== "approved" || !o.result) continue;
        open.delete(o.approvalId);
        const line = approvalResultLine(o.result);
        if (line?.failed) {
          failed.set(
            o.approvalId,
            `\u2705 Approved by ${input.decidedByName} \u00b7 \u26a0\ufe0f ${line.text}`,
          );
        }
      }
      if (failed.size > 0) {
        await rewriteGatewayApprovalCards({
          lines: failed,
          describes: "request",
          onlyPending: false,
        });
      }
    }
  })().catch((err: unknown) =>
    log.warn({ err: String(err) }, "approved-result follow-up failed"),
  );
};
