// Pending-approval value picker — list and resolve held requests through the
// gateway. Like the 1Password client, these hit the gateway directly (different
// base URL + auth) rather than the typed JSON API, so they use
// getGatewayApiUrl() + getGatewayFetchOptions() (edition-aware: Cognito Bearer +
// X-Workspace-Id in cloud, cookie credentials in OSS).
import type { CellOp } from "@onecli/api/lib/record-change";
import { getGatewayApiUrl } from "@/hooks/use-vault-status";
import { getGatewayFetchOptions } from "@/lib/gateway-auth";

export interface ApprovalDetail {
  label: string;
  value: string;
  /** The page of the record this row names. Render it only through
   *  `ApprovalLink`, which enforces `https:`. */
  url?: string;
}

/** Structured, human-readable description of what a held request will do. */
export interface ApprovalSummary {
  action: string;
  /** The familiar shape the request produces, so a card can preview it as
   *  that thing (an email, a calendar event). Absent: plain field rows. */
  kind?: "email" | "event";
  details: ApprovalDetail[];
  /** The title split around the record it names, for a linked title:
   *  `lead + record` equals `action`. Absent when it names no record. */
  subject?: ApprovalSubject;
  /** One request that changes a whole list of records (one approval for
   *  all of them): every record, its new values, and its current ones when
   *  the gateway could read them. */
  bulk?: ApprovalBulkChange;
}

export interface ApprovalBulkChange {
  object: string;
  objectLabel: string;
  fields: ApprovalBulkField[];
  rows: ApprovalBulkRow[];
  /** The records' current values were read: `old` and each cell's op are
   *  meaningful. */
  oldValuesRead: boolean;
  /** What the request does to every record (default update). */
  kind?: "update" | "create" | "delete";
  /** Fields the request also sets that the table leaves out, as labels. */
  hiddenFields?: string[];
  /** Read-only columns that say which record each row is (a contact's
   *  account and title). Never changed, never counted. */
  context?: ApprovalBulkField[];
}

/** A table column: its API name and label. */
export interface ApprovalBulkField {
  api: string;
  label: string;
}

/** What a change does to one field (shared with Slack's card). */
export type ApprovalCellOp = CellOp;

export interface ApprovalBulkRow {
  id: string;
  name?: string;
  /** Gateway-built, https only; render through `ApprovalLink`. */
  url?: string;
  /** Aligned with `fields`; `null` = this row doesn't set it. */
  new: (string | null)[];
  old?: (string | null)[];
  /** What happens to each field, aligned with `fields`. */
  ops?: CellOp[];
  /** The row's strongest op (clear > overwrite > fill > same). */
  op?: CellOp;
  /** Value per `context` column, aligned with it. */
  context?: (string | null)[];
}

export interface ApprovalSubject {
  /** The action without its record ("Delete Contact"): what groups a
   *  task's per-record titles into one card. */
  verb: string;
  lead: string;
  record: string;
  /** Index into `details` of the row naming the record. */
  row: number;
  /** Gateway-built, https only; re-checked before rendering. */
  url?: string;
}

/** The held request's body as the agent sent it. Text only, capped by the
 *  gateway: `truncated` when longer, `binary` (and `text` empty) when not
 *  UTF-8. Always render as text, never as markup. */
export interface ApprovalRawBody {
  text: string;
  truncated: boolean;
  binary: boolean;
  /** Secret-named fields (`password`, `client_secret`, …) were masked. */
  redacted?: boolean;
}

export interface PendingApprovalAgent {
  id: string;
  name: string;
  externalId?: string;
}

/** The agent's `X-OneCLI-Batch*` tag, sanitized by the gateway. Every field
 *  is the agent's own claim: show it as that, never as fact. */
export interface ApprovalBatch {
  id: string;
  label?: string;
  total?: number;
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
  /** The request body verbatim (bounded), for the "Raw request" view. */
  rawBody?: ApprovalRawBody;
  /** Catalog app id this request is for (e.g. `salesforce`), for its logo. */
  app?: string;
  /** The agent's claim that this request is one of a task's several, so
   *  cards can group them. Grouping only: it grants nothing. */
  batch?: ApprovalBatch;
  agent: PendingApprovalAgent;
  /** RFC 3339 timestamp. */
  createdAt: string;
  /** RFC 3339 timestamp: the request is auto-denied at this time. Omitted
   *  when approvals never expire (the gateway sends no deadline). */
  expiresAt?: string;
}

export type ApprovalDecisionInput = "approve" | "deny";

/** How a decision landed: delivered, or the approval was already gone
 * (expired, decided elsewhere, or dropped by a gateway restart). */
export type DecisionOutcome = "delivered" | "already_settled";

/** How a held request ended, once it left the pending list: this browser's
 *  own click ("approved" / "denied"), another surface's decision
 *  ("decided"), or the gateway's auto-deny at the deadline ("expired"). */
export type SettledOutcome =
  | "approved"
  | "denied"
  | "decided"
  | "expired"
  /** The person's newer message changed the request, so it was withdrawn. */
  | "replaced";

/** How a request on a GROUPED card (or its Done record) ended. A replaced
 *  request is never grouped: it is history the person already acted on,
 *  so it always stands as its own one-line record (`approvalTimeline`). */
export type GroupedOutcome = Exclude<SettledOutcome, "replaced">;

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
 * List currently-held approvals for the active workspace. The gateway long-polls
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
 * Submit an approve/deny decision. HTTP 410 (expired) and 404 (no longer in
 * the pending set — decided from another surface, or the gateway restarted
 * and dropped its held requests) both mean the approval is already settled:
 * the card is stale, not the click wrong. Only a real failure throws.
 */
export const decide = async (
  id: string,
  decision: ApprovalDecisionInput,
): Promise<DecisionOutcome> => {
  const { headers, credentials } = await getGatewayFetchOptions();
  const resp = await fetch(`${base()}/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    credentials,
    body: JSON.stringify({ decision }),
  });
  if (resp.ok) return "delivered";
  if (resp.status === 410 || resp.status === 404) return "already_settled";
  const data = (await resp.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? `Request failed (${resp.status})`);
};
