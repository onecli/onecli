import type { LlmProvider } from "./types";
import { parseOpenaiCatalog } from "./openai";

/** `anthropic/claude-sonnet-4` → `Anthropic / Claude Sonnet 4`. */
const humanize = (id: string): string =>
  id
    .split("/")
    .map((segment) =>
      segment
        .split("-")
        .map((part) =>
          /^\d/.test(part)
            ? part
            : part.charAt(0).toUpperCase() + part.slice(1),
        )
        .join(" "),
    )
    .join(" / ");

/**
 * OpenRouter serves the whole platform inventory — embeddings, speech, image,
 * and realtime models included — so selection drops the non-chat modalities.
 * Ids are `vendor/model` with no family prefix to include on, so the rule is
 * exclusion rather than the OpenAI provider's inclusion.
 */
const NOT_CHAT = [
  "embed",
  "moderation",
  "realtime",
  "audio",
  "transcribe",
  "tts",
  "whisper",
  "dall-e",
  "diffusion",
  "image",
  "instruct",
] as const;

/**
 * OpenRouter, a pay-your-own-upstream OpenAI-compatible gateway. The
 * credential is a plain bearer API key, so it lists live like an OpenAI
 * api-key; no OAuth blob exists to refresh.
 */
export const openrouter: LlmProvider = {
  id: "openrouter",
  label: "OpenRouter",
  order: 3,
  defaultModel: "anthropic/claude-sonnet-4",
  efforts: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
  // HARDCODED, never derived from Secret.hostPattern (the SSRF invariant in
  // types.ts).
  catalogUrl: "https://openrouter.ai/api/v1/models",
  canList: (authMode) => authMode === "api-key",
  catalogHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  parseCatalog: parseOpenaiCatalog,
  isSelectable: (id) => {
    const lower = id.toLowerCase();
    return !NOT_CHAT.some((fragment) => lower.includes(fragment));
  },
  labelFor: humanize,
  fallback: [
    "anthropic/claude-sonnet-4",
    "openai/gpt-5.4",
    "google/gemini-3-pro",
    "deepseek/deepseek-v4",
  ],
};
