import { z } from "zod";
import { injectableSecretWhere } from "./injectable-secrets";
import {
  readLlmCredentialValue,
  resolveAgentLlmCredential,
} from "./llm-credential-service";
import type { LlmAuthMode } from "../llm/types";

/**
 * Server-side model calls on an agent's OWN LLM key: the eval judge, the
 * receipt-reaction pick and the point-of-contact reply judge all resolve the
 * key and reach the provider through here, so the wire shape of each key
 * kind lives in one place.
 *
 * Credential discipline: the key is resolved through the SAME fenced grant
 * machinery the sandbox spawn uses (`injectableSecretWhere` →
 * `resolveAgentLlmCredential` → `readLlmCredentialValue`: fail-closed,
 * 1Password-aware), so a call spends exactly the key the agent itself runs
 * on and never another tenant's. The outbound URL is a hardcoded provider
 * origin (never `Secret.hostPattern`, the SSRF note at `llm/types.ts`; the
 * `*_API_BASE_URL` overrides exist for tests), redirects are refused, and the
 * value is never logged or put in an error: errors carry the key kind and
 * the HTTP status only.
 */

/** A readable key for a server-side call. */
export type LlmCallKey =
  | { provider: "anthropic"; authMode: LlmAuthMode; value: string }
  /** A plain OpenAI API key. A ChatGPT sign-in has no server-side door:
   * OpenAI documents ChatGPT plan usage only for apps that register their
   * own Sign in with ChatGPT client, never for a reused Codex login. */
  | { provider: "openai"; value: string };

/** Why an agent has no key usable here. */
export type LlmCallKeyUnavailable =
  /** No LLM key is granted to the agent. */
  | "missing"
  /** The value lives outside OneCLI's store (1Password, the platform trial
   * credit), so the control plane cannot read it. */
  | "not-stored"
  /** A ChatGPT sign-in (see `LlmCallKey`). */
  | "chatgpt-login"
  /** The stored value could not be read back (gone since the lookup, or
   * decryption failed). */
  | "unreadable"
  /** A provider with no server-side call path (OpenCode Go, OpenRouter, or a
   * local OpenAI-compatible server). Sending such a key to api.openai.com
   * would be a cross-vendor credential disclosure. */
  | "unsupported-provider";

type LlmCallKeyResolution =
  | { ok: true; key: LlmCallKey }
  | { ok: false; reason: LlmCallKeyUnavailable };

/**
 * The agent's key for a server-side call, or why there is none. A ChatGPT
 * sign-in is refused before its value is ever decrypted.
 */
export const resolveLlmCallKey = async (
  agent: { id: string; workspaceId: string },
  organizationId: string,
): Promise<LlmCallKeyResolution> => {
  const where = await injectableSecretWhere(
    { id: agent.id },
    agent.workspaceId,
    organizationId,
  );
  const credential = await resolveAgentLlmCredential(
    agent,
    organizationId,
    where,
  );
  if (!credential) return { ok: false, reason: "missing" };
  if (!credential.hasReadableValue) return { ok: false, reason: "not-stored" };
  // Only Anthropic and OpenAI have a server-side call path. The
  // OpenAI-compatible pay-your-own-upstream providers (opencode-go,
  // openrouter, local) must never have their key sent to api.openai.com —
  // that would be a cross-vendor credential disclosure — so they are refused
  // before the value is decrypted.
  if (credential.provider !== "anthropic" && credential.provider !== "openai")
    return { ok: false, reason: "unsupported-provider" };
  if (credential.provider === "openai" && credential.authMode === "oauth")
    return { ok: false, reason: "chatgpt-login" };
  const value = await readLlmCredentialValue(
    agent,
    organizationId,
    credential.secretId,
    where,
  );
  if (!value) return { ok: false, reason: "unreadable" };
  // A stored OpenAI API key is always the bare key: an uploaded auth.json is
  // unwrapped on save (`normalizeOpenaiValue`).
  return {
    ok: true,
    key:
      credential.provider === "anthropic"
        ? { provider: "anthropic", authMode: credential.authMode, value }
        : { provider: "openai", value },
  };
};

/** Required as the first system block for a Claude subscription token:
 * without it Anthropic answers the token with a bare `429 rate_limit_error`
 * on every model (verified live, 2026-10-14). */
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** Why a call failed, in words a dashboard reader may see. `final` failures
 * (a refused key, a refused request) are not worth a retry. Never carries
 * the credential. */
export class LlmCallError extends Error {
  constructor(
    message: string,
    readonly final = false,
  ) {
    super(message);
    this.name = "LlmCallError";
  }
}

/** The provider cannot run the requested model on this call (a 404): an id
 * it does not know or the key cannot reach, or, on OpenAI, a model Chat
 * Completions does not serve (the Responses-only `-pro` and `-codex`
 * models). Final for that model; a caller may still try another one. */
export class LlmModelUnavailableError extends LlmCallError {
  constructor(message: string) {
    super(message, true);
    this.name = "LlmModelUnavailableError";
  }
}

const isSubscription = (key: LlmCallKey) =>
  key.provider === "anthropic" && key.authMode === "oauth";

/** The key kind as the reader knows it. */
const labelOf = (key: LlmCallKey): string =>
  key.provider === "openai"
    ? "OpenAI"
    : isSubscription(key)
      ? "Claude subscription"
      : "Anthropic";

const httpFailure = (key: LlmCallKey, status: number): LlmCallError => {
  const label = labelOf(key);
  const subscription = isSubscription(key);
  if (status === 401 || status === 403)
    return new LlmCallError(
      `The ${label} ${subscription ? "login" : "key"} was refused by the provider (${status})`,
      true,
    );
  if (status === 404)
    return new LlmModelUnavailableError(
      `The ${label} provider cannot run the requested model (404)`,
    );
  if (status === 429)
    return new LlmCallError(
      subscription
        ? `The ${label} usage limit was reached (429); try again later`
        : `The ${label} provider is rate limiting the key (429)`,
    );
  return new LlmCallError(
    `The ${label} provider returned an error (${status})`,
  );
};

/** Call-time reads so tests point at fake servers; the defaults are the
 * hardcoded real origins. */
const originOf = (provider: LlmCallKey["provider"]): string =>
  provider === "anthropic"
    ? (process.env.ANTHROPIC_API_BASE_URL ?? "https://api.anthropic.com")
    : (process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com");

const authHeaders = (key: LlmCallKey): Record<string, string> => {
  if (key.provider === "openai")
    return { authorization: `Bearer ${key.value}` };
  return {
    "anthropic-version": "2023-06-01",
    ...(key.authMode === "oauth"
      ? {
          authorization: `Bearer ${key.value}`,
          "anthropic-beta": "oauth-2025-04-20",
        }
      : { "x-api-key": key.value }),
  };
};

/**
 * POST a JSON body to the key's own provider with the key's own auth, and
 * read the reply through `reply`. Throws `LlmCallError` for a provider
 * answer (an HTTP error or a reply that does not match); network failures
 * and aborts propagate as-is.
 */
export const postToProvider = async <T>(
  key: LlmCallKey,
  path: string,
  body: unknown,
  reply: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> => {
  const response = await fetch(`${originOf(key.provider)}${path}`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", ...authHeaders(key) },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw httpFailure(key, response.status);
  const raw = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // Read as a mismatch below.
  }
  const parsed = reply.safeParse(json);
  if (!parsed.success)
    throw new LlmCallError(
      `The ${labelOf(key)} provider returned a reply that could not be read`,
    );
  return parsed.data;
};

interface LlmCall {
  /** Model id for the key's provider. */
  model: string;
  system?: string;
  prompt: string;
  /** Output ceiling (reasoning tokens count toward it on current models). */
  maxTokens: number;
  /** Constrain the reply to this JSON Schema (strict). */
  jsonSchema?: { name: string; schema: unknown };
  /** `"off"` asks for an answer with no thinking: Anthropic `thinking`
   * disabled at `low` effort, OpenAI `reasoning_effort: "none"`. Omitted,
   * the model thinks as it would by default. */
  thinking?: "off";
  signal: AbortSignal;
}

/** The reply's text, plus the content trouble a provider reports with a
 * 200: a refusal, or output cut off at the ceiling. The caller decides what
 * either means for it. */
interface LlmCallResult {
  text: string;
  stopReason?: "refusal" | "max_tokens";
}

const anthropicMessage = z.object({
  stop_reason: z.string().nullish(),
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .default([]),
});

const chatCompletion = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z
          .object({
            content: z.string().nullish(),
            refusal: z.string().nullish(),
          })
          .optional(),
      }),
    )
    .default([]),
});

const askAnthropic = async (
  key: Extract<LlmCallKey, { provider: "anthropic" }>,
  call: LlmCall,
): Promise<LlmCallResult> => {
  const system = [
    ...(key.authMode === "oauth" ? [CLAUDE_CODE_IDENTITY] : []),
    ...(call.system ? [call.system] : []),
  ].map((text) => ({ type: "text", text }));
  const outputConfig = {
    ...(call.thinking === "off" && { effort: "low" }),
    ...(call.jsonSchema && {
      format: { type: "json_schema", schema: call.jsonSchema.schema },
    }),
  };
  const body = await postToProvider(
    key,
    "/v1/messages",
    {
      model: call.model,
      max_tokens: call.maxTokens,
      ...(system.length > 0 && { system }),
      ...(call.thinking === "off" && { thinking: { type: "disabled" } }),
      ...(Object.keys(outputConfig).length > 0 && {
        output_config: outputConfig,
      }),
      messages: [{ role: "user", content: call.prompt }],
    },
    anthropicMessage,
    call.signal,
  );
  const text = body.content.find((block) => block.type === "text")?.text ?? "";
  if (body.stop_reason === "refusal" || body.stop_reason === "max_tokens")
    return { text, stopReason: body.stop_reason };
  return { text };
};

const askOpenai = async (
  key: Extract<LlmCallKey, { provider: "openai" }>,
  call: LlmCall,
): Promise<LlmCallResult> => {
  const body = await postToProvider(
    key,
    "/v1/chat/completions",
    {
      model: call.model,
      max_completion_tokens: call.maxTokens,
      ...(call.thinking === "off" && { reasoning_effort: "none" }),
      ...(call.jsonSchema && {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: call.jsonSchema.name,
            strict: true,
            schema: call.jsonSchema.schema,
          },
        },
      }),
      messages: [
        ...(call.system ? [{ role: "system", content: call.system }] : []),
        { role: "user", content: call.prompt },
      ],
    },
    chatCompletion,
    call.signal,
  );
  const [choice] = body.choices;
  const text = choice?.message?.content ?? "";
  // Structured output reports a safety refusal in its own field.
  if (choice?.message?.refusal) return { text, stopReason: "refusal" };
  if (choice?.finish_reason === "length")
    return { text, stopReason: "max_tokens" };
  return { text };
};

/** One completion in the key's own shape. Throws `LlmCallError` for a
 * provider answer; network failures and aborts propagate as-is. */
export const callLlm = (
  key: LlmCallKey,
  call: LlmCall,
): Promise<LlmCallResult> =>
  key.provider === "anthropic" ? askAnthropic(key, call) : askOpenai(key, call);
