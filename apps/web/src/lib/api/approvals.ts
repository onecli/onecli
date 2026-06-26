// Pending-approval value picker — list and resolve held requests through the
// gateway. Like the 1Password client, these hit the gateway directly (different
// base URL + auth) rather than the typed JSON API, so they use
// getGatewayApiUrl() + getGatewayFetchOptions() (edition-aware: Cognito Bearer +
// X-Project-Id in cloud, cookie credentials in OSS).
import { getGatewayApiUrl } from "@/hooks/use-vault-status";
import { getGatewayFetchOptions } from "@/lib/gateway-auth";

export interface ApprovalDetail {
  label: string;
  value: string;
}

/** Structured, human-readable description of what a held request will do. */
export interface ApprovalSummary {
  action: string;
  details: ApprovalDetail[];
}

export interface PendingApprovalAgent {
  id: string;
  name: string;
  externalId?: string;
}

export interface PendingApproval {
  id: string;
  method: string;
  url: string;
  host: string;
  path: string;
  headers: Record<string, string>;
  bodyPreview?: string;
  summary?: ApprovalSummary;
  agent: PendingApprovalAgent;
  /** RFC 3339 timestamp. */
  createdAt: string;
  /** RFC 3339 timestamp — the request is auto-denied at this time. */
  expiresAt: string;
}

export type ApprovalDecisionInput = "approve" | "deny";

const base = () => `${getGatewayApiUrl()}/v1/approvals`;

const gatewayGet = async <T>(
  path: string,
  opts?: { signal?: AbortSignal },
): Promise<T> => {
  const { headers, credentials } = await getGatewayFetchOptions();
  const resp = await fetch(`${base()}${path}`, {
    headers,
    credentials,
    signal: opts?.signal,
  });
  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Request failed (${resp.status})`);
  }
  return resp.json() as Promise<T>;
};

/**
 * List currently-held approvals for the active project. The gateway long-polls
 * this endpoint (holds up to ~30s when nothing is pending), so callers should
 * pass an abort signal with a timeout slightly above that hold.
 */
export const listPending = (opts?: {
  signal?: AbortSignal;
}): Promise<PendingApproval[]> =>
  gatewayGet<{ requests: PendingApproval[] }>("/pending", opts).then(
    (r) => r.requests ?? [],
  );

/**
 * Submit an approve/deny decision. HTTP 410 (already resolved or expired) is
 * treated as success — the outcome the caller wanted has already happened.
 */
export const decide = async (
  id: string,
  decision: ApprovalDecisionInput,
): Promise<void> => {
  const { headers, credentials } = await getGatewayFetchOptions();
  const resp = await fetch(`${base()}/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    credentials,
    body: JSON.stringify({ decision }),
  });
  if (resp.ok || resp.status === 410) return;
  const data = (await resp.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? `Request failed (${resp.status})`);
};
