export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  // Active workspace id, returned by /v1/auth/session. Used by client-side
  // redirects to land on /w/[workspaceId]/... rather than the unscoped legacy
  // /overview URL.
  workspaceId?: string;
  // Whether the auth provider proved ownership of `email` (e.g. a verified
  // email claim). Optional — adapters that don't know leave it unset.
  emailVerified?: boolean;
  // Federated IdP name for this session (e.g. "Google"); null/unset for
  // native sign-ins.
  federatedProvider?: string | null;
  // ALL federated IdP names on this session's identity, in token order —
  // multi-linked profiles carry every provider here while federatedProvider
  // only sees the first. Empty/unset for native sign-ins.
  identityProviders?: string[];
}

export type EmailOtpStep = "CONFIRM_SIGN_UP" | "CONFIRM_SIGN_IN" | "DONE";

export interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthUser | null;
  // `callbackURL` is where the browser should land after a federated
  // round-trip — used by invited signups, whose invitation token lives in the
  // page URL and would otherwise be lost across the redirect. Self-hosted
  // only; the Cognito arm ignores it (its callback is fixed by the pool
  // configuration).
  signIn: (options?: { callbackURL?: string }) => Promise<void>;
  signOut: () => Promise<void>;
  // Email + password (self-hosted only, undefined on cloud, which signs in
  // through Cognito). Both reject with a message the form renders as-is.
  signInWithPassword?: (email: string, password: string) => Promise<void>;
  signUpWithPassword?: (input: {
    name: string;
    email: string;
    password: string;
  }) => Promise<void>;
  // Email OTP flow (cloud-only, undefined in OSS mode)
  signUpWithEmail?: (email: string) => Promise<EmailOtpStep>;
  signInWithEmail?: (email: string) => Promise<EmailOtpStep>;
  confirmEmailSignUp?: (email: string, code: string) => Promise<boolean>;
  confirmEmailSignIn?: (code: string) => Promise<boolean>;
  // Enterprise SSO redirect (cloud-only, undefined in OSS mode)
  signInWithSso?: (provider: string) => Promise<void>;
  // Last federated sign-in failure (e.g. an org IdP misconfiguration),
  // surfaced by the auth provider for the login page to render.
  authError?: string | null;
}
