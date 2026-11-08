import { parseOpenaiOAuthJson } from "../validations/secret";
import type { LlmProvider } from "./types";

/** `GET /v1/models` returns `{ data: [{ id, object: "model" }] }` — ids only. */
const parseCatalog = (body: unknown): Array<{ id: string; label?: string }> => {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: Array<{ id: string }> = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") out.push({ id });
  }
  return out;
};

/**
 * A ChatGPT (Codex) login lists on `chatgpt.com/backend-api/codex/models`,
 * the list the Codex client and the agent's runtime both read:
 * `{ models: [{ slug, display_name, visibility }] }`, ordered by the server.
 * Only `visibility: "list"` entries are pickable (the Codex client's own
 * picker rule); `hide` and `none` are internal models and are dropped.
 */
const parseChatGptCatalog = (
  body: unknown,
): Array<{ id: string; label?: string }> => {
  if (typeof body !== "object" || body === null) return [];
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: Array<{ id: string; label?: string }> = [];
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) continue;
    const { slug, display_name, visibility } = entry as {
      slug?: unknown;
      display_name?: unknown;
      visibility?: unknown;
    };
    if (typeof slug !== "string" || slug === "" || visibility !== "list")
      continue;
    out.push({
      id: slug,
      ...(typeof display_name === "string" && display_name !== ""
        ? { label: display_name }
        : {}),
    });
  }
  return out;
};

/**
 * Headers for a ChatGPT login's listing: the CURRENT access token and account
 * id of the Codex `auth.json` blob, the pair the gateway injects. The gateway
 * refreshes an expired token and writes the new blob back to the secret
 * (`refresh_openai_oauth_if_expired`), so this never refreshes anything; a
 * token that expired since just fails the listing, which degrades to the
 * pinned list like any other failure. A blob with no token sends nothing.
 */
const chatGptHeaders = (credential: string): Record<string, string> => {
  const tokens = parseOpenaiOAuthJson(credential)?.tokens;
  if (!tokens?.access_token) return {};
  // Typed as a string by the parser but not checked by it: a hand-edited
  // blob could carry anything, and the gateway ignores a non-string too.
  const accountId =
    typeof tokens.account_id === "string" ? tokens.account_id : "";
  return {
    authorization: `Bearer ${tokens.access_token}`,
    ...(accountId && { "chatgpt-account-id": accountId }),
  };
};

/**
 * OpenAI's `/v1/models` is the account's whole inventory — embeddings, TTS,
 * whisper, moderation, realtime, image models, dated snapshots. Listing it raw
 * would fill the picker with things a coding agent cannot run, so selection is
 * a chat-family prefix minus the modalities that are not chat.
 */
const CHAT_FAMILIES = ["gpt-", "o1", "o3", "o4", "chatgpt-"] as const;
const NOT_CHAT = [
  "embedding",
  "moderation",
  "audio",
  "realtime",
  "transcribe",
  "tts",
  "whisper",
  "image",
  "dall-e",
  "search",
  "instruct",
] as const;

/** `gpt-5.4-pro` → `GPT 5.4 Pro`. */
const humanize = (id: string): string =>
  id
    .split("-")
    .map((part) =>
      part === "gpt"
        ? "GPT"
        : /^\d/.test(part)
          ? part
          : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");

export const openai: LlmProvider = {
  id: "openai",
  label: "OpenAI",
  order: 1,
  defaultModel: "gpt-5.4",
  // Low thinking for the default model, same as Anthropic: fast, cheap turns
  // for agents nobody has tuned. Both defaults accept it.
  defaultEffort: "low",
  // Deliberately short of Anthropic's list. The accepted set is per-provider —
  // the harness says so in its own rejection message — and these three are the
  // ones OpenAI has documented for every reasoning model. A level this omits
  // costs a user nothing; one it wrongly offers costs them a degraded turn.
  efforts: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
  catalogUrl: "https://api.openai.com/v1/models",
  catalogHeaders: (credential, authMode) =>
    authMode === "oauth"
      ? chatGptHeaders(credential)
      : { authorization: `Bearer ${credential}` },
  parseCatalog,
  isSelectable: (id) => {
    const lower = id.toLowerCase();
    if (NOT_CHAT.some((fragment) => lower.includes(fragment))) return false;
    return CHAT_FAMILIES.some((family) => lower.startsWith(family));
  },
  labelFor: humanize,
  fallback: [
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5.1",
    "gpt-5",
    "gpt-5-mini",
  ],
  // A ChatGPT (Codex) login is a different product: gpt-5.4 retired from it
  // ("not supported when using Codex with a ChatGPT account"), it lists on
  // chatgpt.com, and its offline list is what a paid login lists as pickable,
  // newest first. Which models a login may run depends on its ChatGPT plan;
  // the live list is the authority, and a default the login cannot run
  // degrades to the runtime's own default with a visible notice.
  oauth: {
    defaultModel: "gpt-6.1-sol",
    catalogUrl:
      "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
    parseCatalog: parseChatGptCatalog,
    fallback: [
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ],
  },
};
