import type { AdapterPresence } from "@onecli/agent-protocol";

/** The Slack credential shape inside a presence's `credentialsJson` — only
 * slack/ modules know it. The approvals manager receives this as an injected
 * `credentialOf` and treats the returned credential as opaque. */
export const botTokenOf = (presence: AdapterPresence): string | null => {
  if (!presence.credentialsJson) return null;
  try {
    const parsed = JSON.parse(presence.credentialsJson) as {
      botToken?: string;
    };
    return parsed.botToken ?? null;
  } catch {
    return null;
  }
};
