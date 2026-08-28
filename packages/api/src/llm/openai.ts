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
  // An OAuth credential is a JSON blob whose access token the GATEWAY refreshes
  // when it expires. Re-implementing that refresh here to list models would
  // duplicate a security-critical path for a dropdown.
  canList: (authMode) => authMode === "api-key",
  catalogHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
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
};
