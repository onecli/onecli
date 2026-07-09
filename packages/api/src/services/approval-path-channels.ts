import type { ApprovalPathField } from "./approval-path-service";

/** Default hold timeout (seconds) when a channel doesn't specify one. */
export const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 120;

/** Known approval-path channels. */
export const APPROVAL_CHANNELS = {
  ONECLI: "onecli",
  NTFY: "ntfy",
} as const;

export type ApprovalChannel =
  (typeof APPROVAL_CHANNELS)[keyof typeof APPROVAL_CHANNELS];

/**
 * Field definitions per channel — the source of truth for which fields are
 * secret (encrypted into `credentials`) vs plain (stored in `settings`).
 * Shared by the server action (encryption split) and the UI (rendering).
 */
export const APPROVAL_PATH_FIELDS: Record<string, ApprovalPathField[]> = {
  [APPROVAL_CHANNELS.ONECLI]: [{ name: "timeoutSeconds" }],
  [APPROVAL_CHANNELS.NTFY]: [
    { name: "serverUrl" },
    { name: "topic" },
    { name: "callbackBaseUrl" },
    { name: "timeoutSeconds" },
    { name: "priority" },
    { name: "tags" },
    { name: "reportSelection" },
    { name: "publishToken", secret: true },
    { name: "callbackToken", secret: true },
  ],
};

export const getApprovalPathFields = (channel: string): ApprovalPathField[] =>
  APPROVAL_PATH_FIELDS[channel] ?? [];
