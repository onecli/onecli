import { BrandLogo } from "@/lib/components/brand-logo";

/**
 * Why a sign-in that already succeeded could not finish: the account could
 * not be set up, a rate limit, the server out of reach. It replaces the
 * dashboard's skeleton, which must never outlive the failure: someone
 * signed in would otherwise watch it indefinitely with nothing to act on.
 * The root is the page's `main` landmark, as on the other auth screens.
 */
export const AuthSyncError = ({ message }: { message: string }) => (
  <main className="bg-background flex min-h-svh flex-col items-center justify-center px-6 pb-24">
    <BrandLogo />
    <div className="flex flex-col items-center gap-4 py-20">
      <p role="alert" className="text-destructive max-w-sm text-center text-sm">
        {message}
      </p>
    </div>
  </main>
);
