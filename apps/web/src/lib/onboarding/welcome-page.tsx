"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { onboardingPath } from "./steps";
import { useOnboarding } from "./onboarding-context";
import { saveOnboardingProgress } from "./actions";
import { WelcomeDiscoverySection } from "./_components/welcome-discovery-section";

/** Step 1 is ONLY "How did you find us?" — one question, one screen. The
 * mission lives on the next step. Skippable: an unanswered survey question
 * must never hold the product hostage. */
export default function WelcomePage() {
  const router = useRouter();
  const { progress } = useOnboarding();
  const [discovery, setDiscovery] = useState<Set<string>>(
    () => new Set(progress.discovery),
  );

  useEffect(() => {
    router.prefetch(onboardingPath("create"));
  }, [router]);

  const handleDiscoveryToggle = useCallback((id: string) => {
    setDiscovery((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleContinue = () => {
    if (discovery.size > 0) {
      // Fire-and-forget: an unanswered (or unsaved) survey question must
      // never hold the product hostage. `void` alone would leave a
      // network-level rejection unhandled.
      saveOnboardingProgress({ discovery: [...discovery] }).catch(() => {});
    }
    router.push(onboardingPath("create"));
  };

  return (
    <div className="flex w-full max-w-xl flex-col items-center">
      <h1 className="text-center font-serif text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        How did you find us?
      </h1>

      <div className="mt-8 w-full">
        <WelcomeDiscoverySection
          selected={discovery}
          onToggle={handleDiscoveryToggle}
        />
      </div>

      <div className="mt-10 flex items-center justify-center gap-2">
        <Button variant="ghost" size="lg" onClick={handleContinue}>
          Skip
        </Button>
        <Button
          variant="brand"
          size="lg"
          onClick={handleContinue}
          disabled={discovery.size === 0}
        >
          Continue
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
