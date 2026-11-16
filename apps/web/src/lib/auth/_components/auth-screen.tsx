import type { ReactNode } from "react";
import { BrandLogo } from "@/lib/components/brand-logo";
import { Character } from "@/lib/components/character";

export interface AuthScreenProps {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
}

/**
 * The full-page shell every authentication screen shares: brand mark, serif
 * heading, and the card the form sits in.
 *
 * Extracted because the same markup was already repeated verbatim across the
 * self-hosted login, the cloud login and the reviewer login, and sign-up would
 * have made a fourth copy.
 *
 * The root is the page's `main` landmark: these screens render outside the
 * dashboard chrome, so nothing else gives screen-reader users one.
 */
export const AuthScreen = ({ title, subtitle, children }: AuthScreenProps) => (
  <main className="bg-background flex min-h-svh flex-col items-center justify-center px-6 pb-24">
    <BrandLogo />

    <div className="mb-12 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <div className="text-muted-foreground mt-3 text-lg">{subtitle}</div>
    </div>

    <div className="bg-card relative w-full max-w-sm rounded-xl border p-8">
      {/* The green cloud from onecli.sh, perched on the card's top edge. */}
      <Character
        name="cloud"
        size={64}
        className="absolute -top-[55px] right-7"
      />
      {children}

      {/* Inside the card, on the card's own surface — where the cloud login
          screen and the reviewer screen both put it. Outside, it sits on the
          page background and the two screens stop matching. */}
      <p className="text-muted-foreground mt-4 text-center text-xs">
        By continuing, you acknowledge OneCLI&apos;s{" "}
        <a
          href="https://onecli.sh/privacy"
          className="hover:text-foreground underline"
        >
          Privacy Policy
        </a>
        .
      </p>
    </div>
  </main>
);
