/**
 * The gateway's OWN refusals, which ride the same wire as provider errors
 * (sandbox model traffic is proxied): a policy rate limit or block is a
 * self-inflicted, self-fixable condition — telling the user to check their
 * model key would misdirect them, so these always keep the raw passthrough
 * (whose text already names the policy rule). Matched on the gateway's
 * response vocabulary: the "OneCLI policy" phrase in its human messages and
 * the coded JSON bodies (`rate_limited`, `blocked_by_policy`,
 * `access_restricted`).
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
