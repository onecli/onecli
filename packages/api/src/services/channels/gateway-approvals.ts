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
  /** Why a deny happened, when it was not a reviewer's plain no. */
  reason?: "superseded";
}): Promise<GatewayDecisionResult> => {
  const response = await fetch(
    `${getGatewayInternalUrl()}/v1/approvals/${encodeURIComponent(input.approvalId)}/decision`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.serviceKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        decision: input.decision,
        ...(input.reason && { reason: input.reason }),
      }),
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

/** The fields of a held approval the control plane reads. Everything else
 * the gateway sends is ignored; a malformed row is dropped, never fatal. */
const pendingRow = z.object({
  id: z.string(),
  agent: z.object({ id: z.string() }).partial().nullish(),
  summary: z
    .object({
      action: z.string().optional(),
      details: z
        .array(z.object({ label: z.string(), value: z.string() }))
        .optional()
        .catch(undefined),
      bulk: z
        .object({
          objectLabel: z.string(),
          fields: z.array(z.object({ label: z.string() })),
          rows: z.array(
            z.object({
              name: z.string().optional(),
              new: z.array(z.string().nullable()).optional().catch(undefined),
            }),
          ),
        })
        .nullish()
        .catch(undefined),
    })
    .nullish()
    .catch(undefined),
});
export type GatewayPendingApproval = z.infer<typeof pendingRow>;

const pendingResponse = z.object({
  requests: z.array(z.unknown()),
});

/**
 * The workspace's held approvals RIGHT NOW (`wait=0`: never the 30s idle
 * long-poll), read with a key the gateway re-fences to its workspace.
 */
export const listPendingApprovalsAtGateway = async (input: {
  serviceKey: string;
  signal?: AbortSignal;
}): Promise<GatewayPendingApproval[]> => {
  const response = await fetch(
    `${getGatewayInternalUrl()}/v1/approvals/pending?wait=0`,
    {
      headers: { authorization: `Bearer ${input.serviceKey}` },
      signal: input.signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`gateway pending list answered HTTP ${response.status}`);
  }
  const { requests } = pendingResponse.parse(await response.json());
  return requests.flatMap((raw) => {
    const row = pendingRow.safeParse(raw);
    return row.success ? [row.data] : [];
  });
};
