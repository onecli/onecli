"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useOnboarding } from "./onboarding-context";
import { isStepAllowed, stepPathForProgress, type StepSlug } from "./steps";

/** Guards a step page against missing prerequisites (deep links, refreshes
 * with stale progress). Returns whether the step may render; when it may not,
 * replaces the URL with the furthest step the saved progress supports. */
export const useStepGuard = (slug: StepSlug): boolean => {
  const router = useRouter();
  const { progress } = useOnboarding();
  const allowed = isStepAllowed(slug, progress);

  useEffect(() => {
    if (!allowed) {
      router.replace(stepPathForProgress(progress));
    }
  }, [allowed, progress, router]);

  return allowed;
};
