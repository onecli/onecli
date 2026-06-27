/**
 * Hostname fragments for known AI/LLM providers.
 *
 * This is the TypeScript mirror of the gateway's `is_llm_host`
 * (`apps/gateway/src/policy.rs`). A request whose host contains one of these
 * fragments is treated as AI-provider traffic (model inference and the
 * providers' own telemetry alike). **Keep the two lists in sync.**
 */
export const LLM_HOST_FRAGMENTS = [
  "anthropic.com",
  "openai.com",
  "chatgpt.com",
  "deepseek.com",
  "groq.com",
  "openrouter.ai",
  "moonshot.cn",
  "generativelanguage.googleapis.com",
] as const;
