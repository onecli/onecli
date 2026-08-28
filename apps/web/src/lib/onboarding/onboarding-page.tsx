"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useOnboarding } from "./onboarding-context";
import { stepPathForProgress } from "./steps";

/** `/onboarding` resumes at the furthest step the saved progress supports. */
export default function OnboardingPage() {
  const router = useRouter();
  const { progress } = useOnboarding();

  useEffect(() => {
    router.replace(stepPathForProgress(progress));
  }, [router, progress]);

  return null;
}
