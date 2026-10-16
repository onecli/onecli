import type { LlmProvider } from "./types";
import { parseOpenaiCatalog } from "./openai";

/**
 * The well-known local runtimes, so every surface that offers "add a local
 * provider" (the dashboard form, docs, a CLI) renders ONE list instead of
 * re-typing ports.
 *
 * This is convenience copy ONLY: the API accepts any `http(s)` base URL, and a
 * preset merely pre-fills one. There is deliberately ONE provider type
 * (`local`) for all of them — no per-runtime types, because the wire protocol
 * is the same OpenAI-compatible `/v1` shape regardless of who serves it.
 */
export const LOCAL_ENDPOINT_PRESETS = [
  { id: "ollama", label: "Ollama", port: 11434, path: "/v1" },
  { id: "lmstudio", label: "LM Studio", port: 1234, path: "/v1" },
] as const;

/** `llama3.2:latest` → `Llama3.2 Latest`; `qwen2.5-coder:7b` → `Qwen2.5 Coder 7b`. */
const humanize = (id: string): string =>
  id
    .split("/")
    .map((segment) =>
      segment
        .split(/[-:]/)
        .map((part) =>
          /^\d/.test(part)
            ? part
            : part.charAt(0).toUpperCase() + part.slice(1),
        )
        .join(" "),
    )
    .join(" / ");

/**
 * A user-run OpenAI-compatible server at an arbitrary `http(s)` base URL on
 * their LAN — Ollama, LM Studio, llama.cpp, vLLM, anything speaking the same
 * `/v1` shape.
 *
 * The base URL is USER-SUPPLIED and stored in `secret.metadata.baseUrl`, which
 * makes this the ONE deliberate SSRF exception in `types.ts`: the catalogue URL
 * is `<baseUrl>/models` and the host pattern is the base URL's hostname. No DB
 * migration — the base URL rides in the existing `metadata` jsonb.
 *
 * The API key is OPTIONAL. A keyless server lists fine (an empty credential
 * sends no auth header), and when one IS present it is a plain bearer, so this
 * provider lists live exactly like the other OpenAI-compatible ones.
 */
export const local: LlmProvider = {
  id: "local",
  label: "Local (OpenAI-compatible)",
  order: 4,
  // Neutral on purpose: there is no way to know which model a given local
  // server serves, and this default must resolve offline (§3.10).
  defaultModel: "local-model",
  efforts: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
  // The SSRF exception (see `types.ts`): derived from the user's own base URL,
  // never from `Secret.hostPattern`. Trailing slashes are trimmed so a base URL
  // of ".../v1/" does not produce a ".../v1//models" double slash.
  catalogUrlFor: (baseUrl) => `${baseUrl.trim().replace(/\/+$/, "")}/models`,
  canList: (authMode) => authMode === "api-key",
  // Bearer only when a key actually exists: a keyless server's `/models` is
  // public, so we send NO auth header rather than an empty `Bearer `.
  catalogHeaders: (credential): Record<string, string> =>
    credential === "" ? {} : { authorization: `Bearer ${credential}` },
  // A keyless server can still be listed live — see `canListWithoutKey`.
  canListWithoutKey: true,
  parseCatalog: parseOpenaiCatalog,
  // Unlike the curated hosted catalogues, we cannot know which of a local
  // server's models are chat models, so any non-empty id is selectable.
  isSelectable: (id) => id.length > 0,
  labelFor: humanize,
  // Never empty, and the only id we can name with no network. The real list is
  // fetched live from the user's server.
  fallback: ["local-model"],
};
