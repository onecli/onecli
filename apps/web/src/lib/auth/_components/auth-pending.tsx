import { BrandLogo } from "@/lib/components/brand-logo";

export interface AuthPendingProps {
  label: string | null;
  /**
   * Why this stopped, if it did. Rendered INSTEAD of the spinner: the whole
   * point is that a step which failed after the sign-in already succeeded must
   * not read as one that is still working.
   */
  error?: string | null;
}

/** The authentication screens' loading state, while a session resolves. */
export const AuthPending = ({ label, error }: AuthPendingProps) => (
  <div className="bg-background flex min-h-svh flex-col items-center justify-center px-6 pb-24">
    <BrandLogo />
    <div className="flex flex-col items-center gap-4 py-20">
      {error ? (
        <p
          aria-live="polite"
          className="text-destructive max-w-sm text-center text-sm"
        >
          {error}
        </p>
      ) : (
        <>
          <div className="text-brand h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <p className="text-muted-foreground text-sm">
            {label ?? "Loading..."}
          </p>
        </>
      )}
    </div>
  </div>
);
