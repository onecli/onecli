/**
 * Signup human verification, browser side: the literals the Cognito
 * PreSignUp trigger agrees on byte-for-byte. A hosted deployment's
 * server-side check must use the same values: changing one here alone
 * blocks every email signup.
 */

/** SignUp ValidationData key carrying the Turnstile response token. */
export const SIGNUP_VERIFICATION_TOKEN_FIELD = "turnstileToken";

/** The widget `action`; the server only accepts tokens minted for it. */
export const SIGNUP_VERIFICATION_ACTION = "signup";

/** The message a signup denied by the verification trigger carries. */
export const SIGNUP_BLOCKED_ERROR = "SIGNUP_VERIFICATION_FAILED";

/**
 * Whether a failed SignUp was denied by human verification (as opposed to
 * the email already being registered, or anything else). Cognito wraps
 * trigger errors as `UserLambdaValidationException` with the trigger's own
 * message inside, and Amplify keeps both.
 */
export const isSignupVerificationError = (error: unknown): boolean =>
  error instanceof Error &&
  error.name === "UserLambdaValidationException" &&
  error.message.includes(SIGNUP_BLOCKED_ERROR);
