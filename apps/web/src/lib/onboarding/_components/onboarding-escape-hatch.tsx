"use client";

import { usePathname } from "next/navigation";
import { useOnboarding } from "../onboarding-context";
import { stepSlugFromPathname } from "../steps";

/** Footer escape hatches. Skip leaves onboarding entirely; the BYO line is
 * the one mention of connecting an existing agent — deliberately quiet, so
 * the hosted path stays the only primary choice before the wow moment. */
export const OnboardingEscapeHatch = () => {
  const pathname = usePathname();
  const { completing, handleComplete } = useOnboarding();

  const slug = stepSlugFromPathname(pathname);
  if (!slug) return null;

  return (
    <p className="text-muted-foreground mb-2 text-sm">
      Using Claude Code or your own agent?{" "}
      <button
        type="button"
        onClick={() => void handleComplete()}
        disabled={completing}
        className="text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80 disabled:pointer-events-none disabled:opacity-50"
      >
        {completing
          ? "Redirecting..."
          : "Skip and connect it from the dashboard"}
      </button>
    </p>
  );
};
