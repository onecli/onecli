import { z } from "zod";

/** Long enough for any catalog app's id or display name ("Google Calendar",
 * "outlook-calendar"); a pasted paragraph is refused instead of scanned. */
const MAX_APP_QUERY_CHARS = 64;

/**
 * request_app_connection: the model-facing args. One app name or id and
 * nothing else: the agent it is asked for is the resolved caller, never an
 * argument, so strictness makes an extra `agentId` a refusal.
 */
export const requestAppConnectionArgsSchema = z.strictObject({
  app: z
    .string()
    .trim()
    .min(1, 'Name the app, e.g. "jira" or "Google Calendar".')
    .max(MAX_APP_QUERY_CHARS, "Name just the app, not a sentence."),
});
