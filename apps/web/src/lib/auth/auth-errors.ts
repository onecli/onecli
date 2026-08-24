/**
 * Turn the identity layer's error codes into something a person can act on.
 *
 * Kept in one place because the same failure reaches the browser two ways: as
 * a JSON body from the password endpoints, and as a `?error=` query parameter
 * after a refused social sign-in redirects back here. Both carry the same
 * token, so both map through this.
 */

/**
 * The one refusal the server's sign-up path still raises: a pre-2.0 upgrade
 * is mid-adoption and must finish before further accounts may be created.
 */
export const SIGNUP_BLOCKED_BY_UPGRADE = "SIGNUP_BLOCKED_BY_UPGRADE";

/**
 * A Map, not an object literal: the lookup key arrives from the query string
 * on the social-refusal path, so it is attacker-chosen. An object would answer
 * `toString` or `__proto__` with something inherited from the prototype — a
 * function or an object, which React cannot render — and a crafted link would
 * break the sign-in screen for whoever followed it.
 */
const MESSAGES = new Map<string, string>([
  [
    SIGNUP_BLOCKED_BY_UPGRADE,
    "This instance is finishing an upgrade. Its owner needs to sign in first; try again in a moment.",
  ],
  [
    "INVALID_EMAIL_OR_PASSWORD",
    "That email and password don't match an account.",
  ],
  ["INVALID_EMAIL", "That doesn't look like an email address."],
  [
    "PASSWORD_TOO_SHORT",
    "That password is too short. Use at least 8 characters.",
  ],
  ["PASSWORD_TOO_LONG", "That password is too long."],
  [
    "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
    "An account already exists for that email.",
  ],
  [
    "EMAIL_PASSWORD_SIGN_UP_DISABLED",
    "This instance is not accepting new accounts.",
  ],
  ["INVALID_PASSWORD", "Enter a password."],
  // Not a user error: the dashboard's own address is missing from the API's
  // trusted origins, so say what to fix rather than blaming the credentials.
  [
    "INVALID_ORIGIN",
    "This dashboard's address is not trusted by the API. Set ONECLI_EXTERNAL_URL to the URL you browse to, then restart.",
  ],
  // Google sign-in met an existing password account it could not safely
  // absorb (linking requires the existing account's email to be verified;
  // stock self-hosts send no verification mail). The password still works.
  // Only ever reaches us lowercase, via the social-refusal `?error=`
  // redirect — better-auth 1.6.26 has no uppercase API-body twin.
  [
    "account_not_linked",
    "This email already has a password account. Sign in with your password instead.",
  ],
]);

const TOO_MANY_REQUESTS = "Too many attempts. Wait a moment and try again.";

const FALLBACK = "Something went wrong. Try again.";

/**
 * Resolve the copy for a failure.
 *
 * `status` is consulted only for rate limiting, which has no code of its own.
 * An unknown code falls back to the server's own message when it reads like a
 * sentence — better-auth's are in English — and to a generic line otherwise,
 * so a code added upstream degrades instead of showing a bare token.
 */
export const authErrorMessage = (error?: {
  code?: string;
  message?: string;
  status?: number;
}): string => {
  if (!error) return FALLBACK;
  if (error.status === 429) return TOO_MANY_REQUESTS;

  const known = error.code ? MESSAGES.get(error.code) : undefined;
  if (known) return known;

  // A token, not prose: better-auth echoes our refusal code as its message on
  // the social path, and showing "SIGNUP_BLOCKED_BY_UPGRADE" to a person is
  // worse than showing nothing specific.
  const message = error.message?.trim();
  if (!message || /^[A-Z0-9_]+$/.test(message)) return FALLBACK;
  return message;
};

/**
 * The copy for a `?error=` the identity layer redirected back with. Its own
 * failures arrive as lowercase underscored phrases (`unable_to_create_user`);
 * ours arrive as the refusal token.
 */
export const redirectErrorMessage = (code: string): string =>
  MESSAGES.get(code) ?? FALLBACK;
