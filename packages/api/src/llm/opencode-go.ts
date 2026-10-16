import type { LlmProvider } from "./types";
import { parseOpenaiCatalog } from "./openai";

/** `deepseek-v4.1-flash` → `Deepseek V4.1 Flash`; ids carry no display name. */
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
 * The model ids OpenCode Go serves over the **OpenAI `/chat/completions`**
 * protocol — the ONLY inbound protocol jcode's native `opencode-go` provider
 * speaks.
 *
 * OpenCode Go fans one catalogue out over SEVERAL inbound protocols (OpenAI
 * `/chat/completions`, OpenAI `/responses`, Anthropic `/messages`, Google),
 * and its `/models` endpoint carries NO protocol field — so this allow-list is
 * the source of truth (OpenCode Go's published endpoint table). A model absent
 * from here is hidden from the picker ON PURPOSE.
 *
 * CURRENTLY UNSUPPORTED (excluded on purpose):
 * - `/responses`-only: `gpt-6-luna`, `gpt-5.6-luna`, `grok-4.6`, `grok-4.7`,
 *   `muse-spark-1.2-contributor`, `muse-spark-1.3-contributor`.
 * - `/messages`-only: `claude-haiku-5-5`, `minimax-m3`, `qwen3.7-plus`,
 *   `qwen3.8-max`, `qwen3.8-flash`.
 * - Google: `gemini-4-argon-contributor`.
 *
 * jcode has no custom `/responses` (or `/messages`) provider type today, so
 * selecting one would fail with 400 `ModelProtocolUnsupported`. Add a model
 * HERE only once a harness path exists for its protocol.
 */
const CHAT_COMPLETIONS_MODELS = new Set([
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "glm-5.2",
  "glm-5.3",
  "glm-5.3-flash",
  "kimi-k2.7-code",
  "kimi-k3",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "hy3",
  "hy4-preview",
  "space-bunny",
  "longcat-2.0",
  "longcat-2.5-preview-free",
  "step-5-preview",
  "cat-jam-free",
]);

/**
 * OpenCode Go (`opencode.ai/zen/go`), a pay-your-own-upstream
 * OpenAI-compatible endpoint. The credential is a plain bearer API key, so it
 * lists live exactly like an OpenAI api-key — there is no OAuth blob to
 * refresh.
 */
export const opencodeGo: LlmProvider = {
  id: "opencode-go",
  label: "OpenCode Go",
  order: 2,
  defaultModel: "deepseek-v4.1-flash",
  efforts: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
  // HARDCODED, never derived from Secret.hostPattern (the SSRF invariant in
  // types.ts).
  catalogUrl: "https://opencode.ai/zen/go/v1/models",
  canList: (authMode) => authMode === "api-key",
  catalogHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  parseCatalog: parseOpenaiCatalog,
  // Only the OpenAI `/chat/completions` models (see CHAT_COMPLETIONS_MODELS):
  // the endpoint also lists `/responses`- and `/messages`-only models, and
  // offering one would 400 `ModelProtocolUnsupported`.
  isSelectable: (id) => CHAT_COMPLETIONS_MODELS.has(id),
  labelFor: humanize,
  fallback: ["deepseek-v4.1-flash", "deepseek-v4-pro", "glm-5.3"],
};
