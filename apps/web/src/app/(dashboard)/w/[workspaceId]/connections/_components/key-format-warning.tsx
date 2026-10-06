import type { ReactNode } from "react";
import {
  detectAnthropicAuthMode,
  isAnthropicAdminKey,
  isOpenaiAdminKey,
  looksLikeAnthropicKey,
  looksLikeOpenaiKey,
} from "@onecli/api/validations/secret";

const prefixClassName = "text-[11px]";

/**
 * The amber line under an LLM key input: why the pasted value doesn't look
 * like a credential this provider's API accepts, or `null` when it does (or
 * the field is empty). Checks the TRIMMED value, the one that gets saved.
 * Format hints only; they never block saving.
 */
export const keyFormatWarning = (
  type: "anthropic" | "openai",
  raw: string,
): ReactNode => {
  const value = raw.trim();
  if (!value) return null;

  // No provider credential contains whitespace. `claude setup-token` prints a
  // long token that terminals wrap; a single-line input drops the line break
  // but keeps the wrap's indentation, leaving spaces inside the token.
  if (/\s/.test(value)) {
    return "This value contains spaces. A token copied from a wrapped terminal line can pick them up, so remove them.";
  }

  if (type === "anthropic") {
    if (looksLikeAnthropicKey(value)) return null;
    if (isAnthropicAdminKey(value)) {
      return (
        <>
          This looks like an Admin API key, which can{"\u2019"}t call Claude
          models. Paste a subscription token or an API key (
          <code className={prefixClassName}>sk-ant-api03…</code>) instead.
        </>
      );
    }
    if (detectAnthropicAuthMode(value) !== null) {
      return "This value looks incomplete. Make sure you copied all of it.";
    }
    // Only a full-length OpenAI key: a half-typed `sk-a…` is not one yet.
    if (looksLikeOpenaiKey(value)) {
      return "This looks like an OpenAI key, not an Anthropic one.";
    }
    return (
      <>
        Subscription tokens start with{" "}
        <code className={prefixClassName}>sk-ant-oat</code>, API keys with{" "}
        <code className={prefixClassName}>sk-ant-api</code>.
      </>
    );
  }

  if (looksLikeOpenaiKey(value)) return null;
  if (value.startsWith("sk-ant-")) {
    return "This looks like an Anthropic key, not an OpenAI key.";
  }
  if (isOpenaiAdminKey(value)) {
    return (
      <>
        This looks like an Admin API key, which can{"\u2019"}t call models. Use
        a project key (<code className={prefixClassName}>sk-proj-…</code>)
        instead.
      </>
    );
  }
  if (value.startsWith("sk-")) {
    return "This key looks incomplete. Make sure you copied all of it.";
  }
  return (
    <>
      Keys typically start with{" "}
      <code className={prefixClassName}>sk-proj-</code> or{" "}
      <code className={prefixClassName}>sk-</code>.
    </>
  );
};
