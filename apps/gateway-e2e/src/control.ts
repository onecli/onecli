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
  readonly bodyPreview?: string;
  /** The readable card (`summary::ApprovalSummary` on the wire). */
  readonly summary?: {
    readonly action: string;
    /** The familiar shape it produces (`email`, `event`); absent otherwise. */
    readonly kind?: "email" | "event";
    readonly details: ReadonlyArray<{
      label: string;
      value: string;
      /** The record's page, gateway-built (https only); absent otherwise. */
      url?: string;
    }>;
    readonly subject?: {
      verb: string;
      lead: string;
      record: string;
      row: number;
    };
    /** A record table (Salesforce sObject Collections or Composite, or one
     *  record). */
    readonly bulk?: {
      kind: "create" | "update" | "delete";
      object: string;
      objectLabel: string;
      fields: ReadonlyArray<{ api: string; label: string }>;
      rows: ReadonlyArray<{
        id: string;
        name?: string;
        new: ReadonlyArray<string | null>;
      }>;
      hiddenFields?: ReadonlyArray<string>;
    };
  };
  /** The agent's batch tag (`X-OneCLI-Batch*`), when it sent one. */
  readonly batch?: { id: string; label?: string; total?: number };
}

const authHeaders = (apiKey: string): Record<string, string> => ({
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
});

const fetchPending = async (
  gw: GatewayHandle,
  apiKey: string,
  path: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<PendingApproval>> => {
  const res = await fetch(`${gw.origin}${path}`, {
    headers: authHeaders(apiKey),
    signal,
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
 * Longest a single poll inside the wait helpers may hold. The endpoint
 * long-polls up to 30 s on an empty queue, longer than the helpers' whole
 * deadline, so one missed wakeup would otherwise fail the test outright.
 * Abandoning a quiet poll after 2 s and re-polling bounds that cost to 2 s.
 */
const POLL_HOLD_MS = 2_000;

const isPollTimeout = (err: unknown): boolean =>
  err instanceof DOMException && err.name === "TimeoutError";

/** Poll `path` until it lists an approval or `timeoutMs` elapses. */
const waitForPending = async (
  gw: GatewayHandle,
  apiKey: string,
  path: string,
  timeoutMs: number,
): Promise<PendingApproval | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hold = Math.max(1, Math.min(POLL_HOLD_MS, deadline - Date.now()));
    try {
      const pending = await fetchPending(
        gw,
        apiKey,
        path,
        AbortSignal.timeout(hold),
      );
      if (pending[0] !== undefined) return pending[0];
    } catch (err) {
      if (!isPollTimeout(err)) throw err;
      continue;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
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
  const found = await waitForPending(
    gw,
    apiKey,
    "/v1/approvals/pending",
    timeoutMs,
  );
  if (found !== undefined) return found;
  throw new Error(`no approval appeared within ${String(timeoutMs)}ms`);
};

/** Poll the ORG feed until an approval shows up. */
export const waitForOrgApproval = async (
  gw: GatewayHandle,
  orgApiKey: string,
  timeoutMs = 15_000,
): Promise<PendingApproval> => {
  const found = await waitForPending(
    gw,
    orgApiKey,
    "/v1/org/approvals/pending",
    timeoutMs,
  );
  if (found !== undefined) return found;
  throw new Error(`no org approval appeared within ${String(timeoutMs)}ms`);
};
