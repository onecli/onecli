export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  // Active project id, returned by /v1/auth/session. Used by client-side
  // redirects to land on /p/[projectId]/... rather than the unscoped legacy
  // /overview URL.
  projectId?: string;
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
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  // NextAuth id + label of the active login provider (e.g. "google"/"Google" or
  // "oidc"/"Okta"); empty in local mode. Drives the login button.
  authProviderId: string;
  authProviderName: string;
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
