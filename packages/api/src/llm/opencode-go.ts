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
  // The catalogue is a curated coding set: every listed id is runnable, so the
  // only unusable id is an empty one (which the parser already drops).
  isSelectable: (id) => id.length > 0,
  labelFor: humanize,
  fallback: ["deepseek-v4.1-flash", "deepseek-v4-pro", "glm-5.3"],
};
