export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

export type EmailOtpStep = "CONFIRM_SIGN_UP" | "CONFIRM_SIGN_IN" | "DONE";

export interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthUser | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  // Email OTP flow (cloud-only, undefined in OSS mode)
  signUpWithEmail?: (email: string) => Promise<EmailOtpStep>;
  signInWithEmail?: (email: string) => Promise<EmailOtpStep>;
  confirmEmailSignUp?: (email: string, code: string) => Promise<boolean>;
  confirmEmailSignIn?: (code: string) => Promise<boolean>;
}
