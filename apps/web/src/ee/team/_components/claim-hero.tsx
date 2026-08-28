import type { ReactNode } from "react";
import { BrandLogo } from "@/lib/components/brand-logo";

interface ClaimHeroProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Action area (buttons), constrained and centered below the copy. */
  children?: ReactNode;
}

/**
 * Shared hero shell for the claim flow. A card-less, centered layout with a
 * serif headline over an atmospheric brand backdrop, matching the login page's
 * treatment. Presentational only (no hooks), so it renders in both the server
 * and client (sign-in / claim) trees.
 */
export const ClaimHero = ({ title, subtitle, children }: ClaimHeroProps) => (
  <div className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden px-4 py-12">
    {/* Decorative backdrop: a soft brand glow over a faint dot grid. Theme-aware
        (the grid uses currentColor) and fully behind the content. */}
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="text-foreground absolute inset-0 opacity-[0.04] bg-[radial-gradient(currentColor_1px,transparent_1px)] bg-size-[22px_22px] mask-[radial-gradient(ellipse_at_center,#000,transparent_70%)]" />
      <div className="bg-brand/15 absolute top-1/2 left-1/2 size-168 -translate-x-1/2 -translate-y-1/2 rounded-full blur-[130px]" />
    </div>

    <div className="relative z-10 flex w-full max-w-md flex-col items-center text-center motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 animation-duration-[500ms]">
      <BrandLogo />
      <h1 className="font-serif text-3xl font-semibold tracking-tight break-words text-balance sm:text-4xl">
        {title}
      </h1>
      {subtitle && (
        <p className="text-muted-foreground mt-3 text-base text-pretty sm:text-lg">
          {subtitle}
        </p>
      )}
      {children && <div className="mt-8 w-full max-w-sm">{children}</div>}
    </div>
  </div>
);
