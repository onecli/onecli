import {
  TURN_FAILURE_CODES,
  type TurnFailureCode,
} from "@onecli/agent-protocol";

/**
 * The gateway's OWN refusals, which ride the same wire as provider errors
 * (sandbox model traffic is proxied): telling the user to check their model
 * key would misdirect them, so these never read as a provider refusal.
 * Matched on the "OneCLI policy" phrase in the gateway's human messages and
 * its coded bodies, so each predicate below stays safe on its own (inside
 * `terminalErrorClass` a coded body already has its own class).
 */
const GATEWAY_POLICY_SHAPES =
  /onecli policy|"error"\s*:\s*"(rate_limited|blocked_by_policy|access_restricted)"/i;

/**
 * Provider-refusal vocabulary, each token traceable to a shape a provider
 * actually emits:
 * - Anthropic error types: `rate_limit_error` (429),
 *   `authentication_error` (401), `permission_error` / `billing_error`
 *   (403), `overloaded_error` (529), plus the "credit balance is too low"
 *   prose.
 * - OpenAI: `insufficient_quota`, `invalid_api_key`, and the canonical
 *   quota message ("exceeded your current quota … check your plan and
 *   billing details").
 * - Plain prose limits: "rate limit" / "usage limit" (subscription-style
 *   refusals that arrive as sentences, not typed JSON).
 *
 * Deliberately EXCLUDED, because a match here would swap a real error for
 * misleading "check the model key" guidance:
 * - `invalid_request_error` — the provider's 400 catch-all. It covers
 *   context-window overflow ("prompt is too long"), where resending can
 *   never succeed and the key is fine.
 * - The harness's generic "API error" wrapper prefix — it wraps EVERY
 *   model-endpoint HTTP failure, including provider-side 500s
 *   (`api_error`) that no key change can fix.
 * - Bare "billing" — one common English word; a terminal error merely
 *   quoting it (a tool name, echoed request text) must not be re-dressed
 *   as a key problem.
 */
const PROVIDER_REFUSAL_SHAPES =
  /\brate.?limits?|authentication_error|permission_error|overloaded_error|billing_error|invalid_api_key|insufficient[_ ]quota|exceeded your current quota|billing (details|hard limit)|\busage limits?|credit balance/i;

/**
 * The gateway's trial-credit pause: the coded `trial_credit_exhausted` JSON
 * body it returns when the PLATFORM's free credit hits its spend cap (the
 * ORG-budget sibling keeps `budget_exceeded` and the raw passthrough — its
 * message names an admin-configured budget, which is accurate there).
 * Matched on the gateway's own code (never prose), and checked BEFORE the
 * general policy and provider shapes: it is a gateway response, but unlike a
 * policy block the fix is the user's — connect a key — so it earns canonical
 * copy with the add-key call to action instead of the raw passthrough.
 */
const TRIAL_CREDIT_SHAPE = /"error"\s*:\s*"trial_credit_exhausted"/i;

export const isTrialCreditExhausted = (message: string): boolean =>
  TRIAL_CREDIT_SHAPE.test(message);

/**
 * The gateway's OWN coded answers on a model call, mapped to the failure
 * class a person can act on. The gateway answers in a FLAT shape
 * (`"error": "<code>"` beside a readable `message`), which a provider never
 * uses (providers nest an object under `error`), so matching the flat code is
 * matching the gateway, never prose. The coverage test reads the gateway's
 * request-path response builders and fails on a code this table does not
 * classify, so a new one cannot reach the chat as raw JSON unnoticed.
 *
 * `trial_credit_exhausted` is deliberately absent: it keeps its own sharper
 * class (`isTrialCreditExhausted`), checked first. A Map, so a code read off
 * untrusted text can never resolve to a prototype member.
 */
const GATEWAY_CODE_CLASS: ReadonlyMap<string, TurnFailureCode> = new Map<
  string,
  TurnFailureCode
>([
  // A key exists in the workspace; this agent was not given it.
  ["access_restricted", TURN_FAILURE_CODES.modelKeyNotAttached],
  // This agent was given the key, but its stored value could not be read:
  // the fix is re-entering it, not attaching or checking it.
  ["credential_unavailable", TURN_FAILURE_CODES.modelKeyUnreadable],
  // The agent has no usable key for this host: the fix is the key, on the
  // agent's Models page.
  ["credential_not_found", TURN_FAILURE_CODES.modelProviderError],
  ["app_not_connected", TURN_FAILURE_CODES.modelProviderError],
  ["connection_needs_reconnect", TURN_FAILURE_CODES.modelProviderError],
  ["connection_host_mismatch", TURN_FAILURE_CODES.modelProviderError],
  ["connection_not_found", TURN_FAILURE_CODES.modelProviderError],
  ["multiple_connections", TURN_FAILURE_CODES.modelProviderError],
  ["multiple_providers", TURN_FAILURE_CODES.modelProviderError],
  // An admin's rule decided: a policy, a limit, a refused approval.
  ["blocked_by_policy", TURN_FAILURE_CODES.blockedByPolicy],
  ["blocked_by_default_policy", TURN_FAILURE_CODES.blockedByPolicy],
  ["rate_limited", TURN_FAILURE_CODES.blockedByPolicy],
  ["quota_exceeded", TURN_FAILURE_CODES.blockedByPolicy],
  ["budget_exceeded", TURN_FAILURE_CODES.blockedByPolicy],
  ["manual_approval_denied", TURN_FAILURE_CODES.blockedByPolicy],
  ["destination_not_allowed", TURN_FAILURE_CODES.blockedByPolicy],
  ["method_override_refused", TURN_FAILURE_CODES.blockedByPolicy],
  ["resource_access_denied", TURN_FAILURE_CODES.blockedByPolicy],
  ["app_unavailable", TURN_FAILURE_CODES.blockedByPolicy],
  ["github_org_access_required", TURN_FAILURE_CODES.blockedByPolicy],
  // The gateway itself could not complete the call: temporary.
  ["gateway_restarting", TURN_FAILURE_CODES.gatewayUnavailable],
  ["upstream_unreachable", TURN_FAILURE_CODES.gatewayUnavailable],
  ["upstream_timeout", TURN_FAILURE_CODES.gatewayUnavailable],
  ["bad_gateway", TURN_FAILURE_CODES.gatewayUnavailable],
  ["approval_store_unavailable", TURN_FAILURE_CODES.gatewayUnavailable],
  ["resolution_failed", TURN_FAILURE_CODES.gatewayUnavailable],
]);

/** The FLAT gateway shape `"error": "<code>"`, with the quotes optionally
 * escaped when the body is quoted inside another string. A provider's nested
 * `"error": {` never matches (the value must be a string). No nested
 * quantifiers: the text is untrusted and can be long. */
const GATEWAY_CODE = /"error\\?"\s*:\s*\\?"([a-z_]{1,64})\\?"/;

/** The failure class for a terminal error carrying one of the gateway's own
 * codes, or `undefined` when the text holds none this table knows (a
 * provider error, a harness error, an unknown code). */
const gatewayFailureCode = (message: string): TurnFailureCode | undefined => {
  const code = GATEWAY_CODE.exec(message)?.[1];
  return code === undefined ? undefined : GATEWAY_CODE_CLASS.get(code);
};

/**
 * The provider rejecting the CONVERSATION ITSELF as malformed. None of these
 * is a key problem (so it must never read as a provider refusal), and none
 * can succeed on resend: the stored transcript is replayed whole on every
 * turn, so the same request is rejected forever until the transcript is
 * repaired. Matched on the provider's own wording, which names the offending
 * shape:
 * - a `tool_use` not answered by a `tool_result` in the very next message,
 *   and its sibling, a `tool_result` no `tool_use` asked for (issue #1194: a
 *   torn checkpoint doubled the history);
 * - an image block whose media type the provider does not accept (an agent
 *   that opened a `.bmp` or `.ico` stored it as `image/bmp`/`image/x-icon`);
 * - a provider-rejected encrypted search result or signed thinking block.
 * The jcode adapter repairs the tool-result and image shapes at boot. Signed
 * replay failures are not repaired here.
 */
const TRANSCRIPT_REJECTED_SHAPE =
  /tool_use`? ids were found without `?tool_result|unexpected `?tool_use_id`? found in `?tool_result|image\.source\.base64\.media_type: Input should be|\bInvalid `?(?:encrypted_content`? in `?(?:web_)?search_result|signature`? in `?thinking)`? block\b/i;

export const isTranscriptRejected = (message: string): boolean =>
  TRANSCRIPT_REJECTED_SHAPE.test(message);

/**
 * The MODEL ENDPOINT answering 404: the provider does not know the
 * configured model, or the request reached something with no such route (a
 * wrong endpoint address, a proxy in front of the provider forwarding to a
 * path it does not serve). Setup, not the message and not the key: a new
 * key never fixes it, and a resend only helps when a proxy misrouted a
 * single call. Matched on the harness's own wrapper around a model-endpoint
 * HTTP failure ("Anthropic API error (404 Not Found)", "API Error: 404"),
 * never on a bare "404": a tool's output quoting a 404 must keep its raw
 * passthrough.
 *
 * Observed live: a proxy's retry that forwarded to a path the backend does
 * not serve, answering a cloud-style `{"error":{"code":"404", ...}}` body
 * behind the Anthropic wrapper.
 *
 * The gateway's OWN 404s (`credential_not_found`, an unknown connection)
 * are not this: they name their fix, and their code has its own class.
 */
const MODEL_ENDPOINT_NOT_FOUND_SHAPE = /\bapi error:?\s*\(?404\b/i;
const GATEWAY_NOT_FOUND_SHAPE = /"error"\s*:\s*"credential_not_found"/i;

export const isModelEndpointNotFound = (message: string): boolean =>
  MODEL_ENDPOINT_NOT_FOUND_SHAPE.test(message) &&
  !GATEWAY_NOT_FOUND_SHAPE.test(message) &&
  !GATEWAY_POLICY_SHAPES.test(message);

/**
 * Whether a harness terminal error is the MODEL PROVIDER refusing the
 * request (usage limit, exhausted credits, revoked key) — the one live-
 * harness failure a person can actually fix, so it earns a code and
 * canonical copy instead of the raw passthrough. Anything else keeps
 * today's uncoded raw error.
 *
 * The vocabulary is the PROVIDERS' (Anthropic/OpenAI wire shapes), not any
 * harness's — a refusal relayed by any adapter reads the same — which is
 * what lets this live above the harness boundary without branching on a
 * vendor frame.
 */
export const isProviderRefusal = (message: string): boolean =>
  !GATEWAY_POLICY_SHAPES.test(message) && PROVIDER_REFUSAL_SHAPES.test(message);

/**
 * The failure class a live harness's terminal error text earns, or
 * `undefined` to keep the raw passthrough. Most specific first:
 * - a rejected transcript before anything else: its 400 must never read as a
 *   key problem (#1194);
 * - the trial-credit pause, a gateway code with its own add-a-key fix;
 * - every other gateway code, before the provider shapes, so
 *   `access_restricted` reads as a missing grant, not a broken key;
 * - the provider refusing the key;
 * - a model-endpoint 404 last: a 404 whose body also names a refusal (a
 *   quota page behind a proxy) keeps the more actionable key copy.
 */
export const terminalErrorClass = (
  message: string,
): TurnFailureCode | undefined => {
  if (isTranscriptRejected(message)) {
    return TURN_FAILURE_CODES.transcriptRejected;
  }
  if (isTrialCreditExhausted(message)) {
    return TURN_FAILURE_CODES.trialCreditExhausted;
  }
  const gateway = gatewayFailureCode(message);
  if (gateway) return gateway;
  if (isProviderRefusal(message)) return TURN_FAILURE_CODES.modelProviderError;
  if (isModelEndpointNotFound(message)) {
    return TURN_FAILURE_CODES.modelEndpointNotFound;
  }
  return undefined;
};
