import {
  readLlmCredentialValue,
  resolveAgentLlmCredential,
  type ResolvedLlmCredential,
} from "../llm-credential-service";
import { injectableSecretWhere } from "../injectable-secrets";
import { parseOpenaiOAuthJson } from "../../validations/secret";
import { logger } from "../../lib/logger";

const log = logger.child({ component: "reaction-chooser" });

/**
 * The receipt-reaction chooser: pick ONE emoji, relevant to the inbound
 * message, to mark it "seen" while the turn runs. AI when possible, `eyes`
 * whenever not — the reaction is cosmetic, so every failure arm degrades to
 * the fallback and NOTHING here may delay or fail an ingest.
 *
 * This is the repo's first server-side inference call with a customer
 * credential, so it inherits the catalog-cache disciplines deliberately:
 * the key is resolved through the SAME fenced grant machinery the sandbox
 * spawn uses (`injectableSecretWhere` → `resolveAgentLlmCredential` →
 * `readLlmCredentialValue` — fail-closed, 1Password-aware), the outbound
 * URL is a hardcoded provider origin (never `Secret.hostPattern`, the SSRF
 * note at `llm/types.ts`), redirects are refused, and the credential is
 * used in-process and never logged.
 */

/** Slack reaction names the model may pick from — the output boundary: a
 * non-member answer (whatever the model says) falls back. */
export const REACTION_ALLOWLIST = [
  "eyes",
  "wave",
  "thumbsup",
  "thinking_face",
  "mag",
  "memo",
  "rocket",
  "bulb",
  "question",
  "bug",
  "book",
  "gear",
  "calendar",
  "chart_with_upwards_trend",
] as const;

export const FALLBACK_REACTION = "eyes";

/** Hard ceiling on the pick — the receipt must land promptly or not at all. */
const CHOOSER_TIMEOUT_MS = 1_500;

/** The message text the model sees, clamped — a pick needs a gist, not a
 * transcript. */
const TEXT_CLAMP = 500;

/**
 * Chooser-owned FAST models — deliberately not the agent's resolved model:
 * an opus-class pick would blow the timeout and the fallback would always
 * win. A stale id here degrades to the fallback (the call 4xxs), never to an
 * error the caller sees.
 */
const FAST_MODELS = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
} as const;

/** Call-time reads so tests point at fake servers (the SLACK_API_BASE_URL
 * pattern); the defaults are the hardcoded real origins. */
const apiBase = (provider: "anthropic" | "openai"): string =>
  provider === "anthropic"
    ? (process.env.ANTHROPIC_API_BASE_URL ?? "https://api.anthropic.com")
    : (process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com");

const prompt = (text: string): string =>
  [
    "Pick the single most fitting acknowledgment emoji for this chat message.",
    `Answer with EXACTLY one name from this list and nothing else: ${REACTION_ALLOWLIST.join(", ")}.`,
    `Message: ${text.slice(0, TEXT_CLAMP)}`,
  ].join("\n");

/** ":eyes:" / "Eyes " / "eyes." → "eyes"; anything else falls out at the
 * allowlist check. */
const normalize = (answer: string): string =>
  answer.trim().toLowerCase().replaceAll(":", "").split(/\s/)[0] ?? "";

const isAllowlisted = (
  name: string,
): name is (typeof REACTION_ALLOWLIST)[number] =>
  (REACTION_ALLOWLIST as readonly string[]).includes(name);

const askAnthropic = async (
  credential: ResolvedLlmCredential,
  value: string,
  text: string,
): Promise<string> => {
  const response = await fetch(`${apiBase("anthropic")}/v1/messages`, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(credential.authMode === "oauth"
        ? {
            authorization: `Bearer ${value}`,
            "anthropic-beta": "oauth-2025-04-20",
          }
        : { "x-api-key": value }),
    },
    body: JSON.stringify({
      model: FAST_MODELS.anthropic,
      max_tokens: 8,
      messages: [{ role: "user", content: prompt(text) }],
    }),
    signal: AbortSignal.timeout(CHOOSER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`anthropic ${response.status}`);
  const body = (await response.json()) as {
    content?: { type?: string; text?: string }[];
  };
  return body.content?.find((block) => block.type === "text")?.text ?? "";
};

const askOpenai = async (value: string, text: string): Promise<string> => {
  // OpenAI values are either a bare key or an auth JSON blob; OAuth blobs
  // carry the access token (which the gateway refreshes — an expired one
  // simply 401s into the fallback here).
  const key = value.startsWith("{")
    ? (parseOpenaiOAuthJson(value)?.tokens.access_token ??
      (JSON.parse(value) as { OPENAI_API_KEY?: string }).OPENAI_API_KEY)
    : value;
  if (!key) throw new Error("no usable openai credential");
  const response = await fetch(`${apiBase("openai")}/v1/chat/completions`, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: FAST_MODELS.openai,
      max_tokens: 8,
      messages: [{ role: "user", content: prompt(text) }],
    }),
    signal: AbortSignal.timeout(CHOOSER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`openai ${response.status}`);
  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return body.choices?.[0]?.message?.content ?? "";
};

export const chooseReaction = async (input: {
  agent: { id: string; workspaceId: string };
  organizationId: string;
  text: string;
}): Promise<string> => {
  try {
    const where = await injectableSecretWhere(
      { id: input.agent.id },
      input.agent.workspaceId,
      input.organizationId,
    );
    const credential = await resolveAgentLlmCredential(
      input.agent,
      input.organizationId,
      where,
    );
    if (!credential?.hasReadableValue) return FALLBACK_REACTION;
    const value = await readLlmCredentialValue(
      input.agent,
      input.organizationId,
      credential.secretId,
      where,
    );
    if (!value) return FALLBACK_REACTION;

    const answer =
      credential.provider === "anthropic"
        ? await askAnthropic(credential, value, input.text)
        : await askOpenai(value, input.text);
    const pick = normalize(answer);
    return isAllowlisted(pick) ? pick : FALLBACK_REACTION;
  } catch (err) {
    // Timeouts, refusals, stale fast-model ids, parse trouble: all cosmetic.
    log.debug({ err: String(err) }, "reaction pick fell back");
    return FALLBACK_REACTION;
  }
};
