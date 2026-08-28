import { z } from "zod";

/**
 * The Slack-shaped credential JSONs stored (encrypted) on the generic channel
 * models. These shapes exist ONLY inside the Slack provider modules — the
 * platform layer treats the strings as opaque (§step-6: nothing outside
 * `providers/slack/` thinks in Slack terms).
 *
 * Parsed with zod on every decrypt rather than cast: a stored blob survives
 * deploys and refactors, so its shape is an input, not an invariant.
 */

/** The org integration's rotating app-configuration token pair (12h expiry,
 * single-use refresh — `tooling.tokens.rotate`). */
export const slackIntegrationCredentialsSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    /** Unix seconds the access token expires, from Slack's `exp`. */
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type SlackIntegrationCredentials = z.infer<
  typeof slackIntegrationCredentialsSchema
>;

/**
 * A presence's own credentials. Client creds + signing secret arrive at
 * `apps.manifest.create` (or are absent on the paste floor, where Slack shows
 * them only in its UI — the bot token alone is enough to operate); tokens
 * arrive at completion. `appToken` (xapp-, Socket Mode) exists only on the
 * socket arm; `botToken` (xoxb-) exists once installed.
 */
export const slackPresenceCredentialsSchema = z
  .object({
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    signingSecret: z.string().min(1).optional(),
    botToken: z.string().min(1).optional(),
    appToken: z.string().min(1).optional(),
  })
  .strict();
export type SlackPresenceCredentials = z.infer<
  typeof slackPresenceCredentialsSchema
>;

export const parseSlackIntegrationCredentials = (
  json: string,
): SlackIntegrationCredentials =>
  slackIntegrationCredentialsSchema.parse(JSON.parse(json));

export const parseSlackPresenceCredentials = (
  json: string,
): SlackPresenceCredentials =>
  slackPresenceCredentialsSchema.parse(JSON.parse(json));
