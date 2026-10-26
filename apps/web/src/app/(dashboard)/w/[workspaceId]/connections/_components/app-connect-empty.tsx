"use client";

import { useId } from "react";
import { Plug } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import type { PageScope } from "@/lib/api";

export interface AppConnectEmptyProps {
  appName: string;
  pageScope: PageScope;
  onConnect: () => void;
}

/**
 * An app page with no account yet. It sits exactly where the account cards
 * will land (the dashed edge reads as "an account goes here"), says what
 * connecting does, and repeats the header's Connect as a quieter, in-place
 * action in the brand tint the sidebar uses for "you are here".
 */
export const AppConnectEmpty = ({
  appName,
  pageScope,
  onConnect,
}: AppConnectEmptyProps) => {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="animate-in fade-in-0 slide-in-from-bottom-1 border-foreground/15 rounded-xl border border-dashed p-5 duration-300 motion-reduce:animate-none"
    >
      <h2 id={headingId} className="text-sm font-medium">
        No {appName} account connected yet
      </h2>
      <p className="text-muted-foreground mt-1 max-w-prose text-sm text-pretty">
        {pageScope === "organization"
          ? "Connect it once and every workspace can turn it on for its agents."
          : "Connect an account, then choose which agents can use it."}{" "}
        Agents never see the credential.
      </p>
      {/* The brand green itself sits under 4.5:1 on its own tint, so the
          label takes a deeper mix of it in light mode and a lighter one in
          dark: same hue, readable text. "your" reads right before any app
          name ("a AWS" / "a Outlook" would not). */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onConnect}
        className="bg-brand/10 ring-brand/25 hover:bg-brand/15 dark:hover:bg-brand/20 mt-4 text-[color-mix(in_oklab,var(--color-brand)_72%,black)] ring-1 ring-inset hover:text-[color-mix(in_oklab,var(--color-brand)_72%,black)] dark:text-[color-mix(in_oklab,var(--color-brand)_65%,white)] dark:hover:text-[color-mix(in_oklab,var(--color-brand)_65%,white)]"
      >
        <Plug aria-hidden="true" />
        Connect your {appName} account
      </Button>
    </section>
  );
};
