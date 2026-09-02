import { z } from "zod";
import { getGatewayInternalUrl } from "../../lib/env";

/**
 * The control plane's client for the GATEWAY's approvals API — used by the
 * events arm's interactivity route to decide an approval server-side with a
 * presence's service key. (The socket arm's adapter carries its own copy of
 * this shape against the same endpoints; two thin clients, two runtimes.)
 *
 * The gateway accepts `oc_` bearer keys on these routes by design — the one
 * auth path that needs no browser (its e2e suite says exactly this) — and
 * re-validates the key owner's live workspace access per call, which is what
 * `approved_by` attribution rests on.
 */

const CALL_TIMEOUT_MS = 10_000;

const decisionResponse = z.object({ success: z.boolean().optional() });

export type GatewayDecisionResult =
  | { outcome: "decided" }
  /** 410 — someone else (or the timeout) got there first. Treated as settled,
   * the same way the web client does. */
  | { outcome: "already_settled" }
  | { outcome: "unauthorized" }
  | { outcome: "not_found" };

export const decideApprovalAtGateway = async (input: {
  serviceKey: string;
  approvalId: string;
  decision: "approve" | "deny";
}): Promise<GatewayDecisionResult> => {
  const response = await fetch(
    `${getGatewayInternalUrl()}/v1/approvals/${encodeURIComponent(input.approvalId)}/decision`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.serviceKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: input.decision }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    },
  );

  if (response.status === 410) return { outcome: "already_settled" };
  if (response.status === 401 || response.status === 403) {
    return { outcome: "unauthorized" };
  }
  if (response.status === 404) return { outcome: "not_found" };
  if (!response.ok) {
    throw new Error(`gateway decision answered HTTP ${response.status}`);
  }
  decisionResponse.parse(await response.json());
  return { outcome: "decided" };
};
