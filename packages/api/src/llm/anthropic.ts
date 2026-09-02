import type { LlmProvider } from "./types";

/**
 * `GET /v1/models` returns `{ data: [{ id, display_name, type: "model" }] }`.
 * Anthropic serves only Claude models, so the selectable rule is simply "is a
 * Claude model" — no capability filtering is needed the way it is for OpenAI.
 */
const parseCatalog = (body: unknown): Array<{ id: string; label?: string }> => {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: Array<{ id: string; label?: string }> = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, display_name: displayName } = entry as {
      id?: unknown;
      display_name?: unknown;
    };
    if (typeof id !== "string" || id === "") continue;
    out.push({
      id,
      ...(typeof displayName === "string" &&
        displayName !== "" && { label: displayName }),
    });
  }
  return out;
};

/** `claude-sonnet-4-6` → `Claude Sonnet 4.6`, used only when the API sends no
 *  display name (the bare harness aliases never carry one). */
const humanize = (id: string): string =>
  id
    .split("-")
    .map((part) =>
      /^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ")
    .replace(/(\d) (\d)/g, "$1.$2");

export const anthropic: LlmProvider = {
  id: "anthropic",
  label: "Anthropic",
  order: 0,
  // Sonnet, per the standing default. Verified accepted by the harness against
  // a placeholder key (the sandbox's actual condition) — a default that the
  // harness rejects would degrade every agent nobody has configured, which is
  // most of them.
  defaultModel: "claude-sonnet-5",
  efforts: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  catalogUrl: "https://api.anthropic.com/v1/models?limit=100",
  // An OAuth token is a subscription credential, not an API key; the models
  // endpoint expects `x-api-key`. Rather than guess at a bearer flow we do not
  // use anywhere else, that mode falls back to the pinned list.
  canList: (authMode) => authMode === "api-key",
  catalogHeaders: (credential) => ({
    "x-api-key": credential,
    "anthropic-version": "2023-06-01",
  }),
  parseCatalog,
  isSelectable: (id) => id.startsWith("claude-"),
  labelFor: humanize,
  // The offline answer only — the live list is the real one. Every id here was
  // verified accepted by the harness, because this list is what a user picks
  // from when the provider cannot be reached.
  fallback: [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ],
};
