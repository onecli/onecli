/**
 * Whether this deployment can sign session cookies at all.
 *
 * Self-hosted logins are not optional any more — without a secret the identity
 * layer refuses to build, and every page would surface that as an unhandled
 * error rather than as the one-line configuration problem it is. The
 * dashboard's setup gate asks this and says so instead.
 *
 * Env is read at call time (not module load) so long-lived processes and tests
 * see current values, and values are trimmed before every presence test:
 * compose passes variables through as empty strings rather than leaving them
 * out. Pure env — safe for any bundle.
 */

/** Every variable the identity layer will accept as its signing secret. */
const SESSION_SECRET_VARS = ["BETTER_AUTH_SECRET", "AUTH_SECRET"] as const;

const isSet = (name: string): boolean => Boolean(process.env[name]?.trim());

/**
 * `AUTH_SECRET` counts because better-auth falls back to it: a deployment
 * configured that way genuinely has working logins, and reporting it as
 * unconfigured would send a working install to the setup screen.
 */
export const isMissingSessionSecret = (): boolean =>
  !SESSION_SECRET_VARS.some(isSet);
