import type { GatewayHandle } from "./gateway.js";

/**
 * The gateway's control-plane surface, as the dashboard uses it.
 *
 * Authentication is an `oc_` API key, deliberately: it is the one path that
 * needs neither Cognito nor a browser session, so these tests exercise the real
 * extractor without standing up an identity provider.
 */

export interface PendingApproval {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly workspaceId?: string;
  /** Rename compat: dual-emitted for released SDKs; equals `workspaceId`. */
  readonly projectId?: string;
}

const authHeaders = (apiKey: string): Record<string, string> => ({
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
});

const fetchPending = async (
  gw: GatewayHandle,
  apiKey: string,
  path: string,
): Promise<ReadonlyArray<PendingApproval>> => {
  const res = await fetch(`${gw.origin}${path}`, {
    headers: authHeaders(apiKey),
  });
  if (res.status !== 200) {
    throw new Error(`GET ${path} → ${String(res.status)}: ${await res.text()}`);
  }
  const body = (await res.json()) as { requests?: PendingApproval[] };
  return body.requests ?? [];
};

export const pendingApprovals = async (
  gw: GatewayHandle,
  apiKey: string,
): Promise<ReadonlyArray<PendingApproval>> =>
  fetchPending(gw, apiKey, "/v1/approvals/pending");

/** The org feed, polled with a bare `oc_org_` key (no workspace header). */
export const pendingOrgApprovals = async (
  gw: GatewayHandle,
  orgApiKey: string,
): Promise<ReadonlyArray<PendingApproval>> =>
  fetchPending(gw, orgApiKey, "/v1/org/approvals/pending");

export interface DecisionResult {
  readonly status: number;
  readonly body: unknown;
}

export const decideApproval = async (
  gw: GatewayHandle,
  apiKey: string,
  id: string,
  decision: "approve" | "deny",
  extraHeaders: Record<string, string> = {},
): Promise<DecisionResult> => {
  const res = await fetch(`${gw.origin}/v1/approvals/${id}/decision`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), ...extraHeaders },
    body: JSON.stringify({ decision }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/**
 * Poll until an approval shows up.
 *
 * The endpoint long-polls internally, but a held request only registers once the
 * gateway has buffered and summarised it, so a bounded retry keeps the tests
 * from depending on that timing.
 */
export const waitForApproval = async (
  gw: GatewayHandle,
  apiKey: string,
  timeoutMs = 15_000,
): Promise<PendingApproval> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = await pendingApprovals(gw, apiKey);
    if (pending[0] !== undefined) return pending[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no approval appeared within ${String(timeoutMs)}ms`);
};

/** Poll the ORG feed until an approval shows up. */
export const waitForOrgApproval = async (
  gw: GatewayHandle,
  orgApiKey: string,
  timeoutMs = 15_000,
): Promise<PendingApproval> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = await pendingOrgApprovals(gw, orgApiKey);
    if (pending[0] !== undefined) return pending[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no org approval appeared within ${String(timeoutMs)}ms`);
};
