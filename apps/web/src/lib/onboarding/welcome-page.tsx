"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { cn } from "@onecli/ui/lib/utils";
import { onboardingPath } from "./steps";
import { useOnboarding } from "./onboarding-context";
import { saveOnboardingProgress } from "./actions";
import { useScreenExit } from "./use-screen-exit";
import {
  DEFAULT_MESSAGING_TOOL,
  MESSAGING_TOOL_OPTIONS,
  WelcomeMessagingSection,
  type MessagingToolId,
} from "./_components/welcome-messaging-section";

const OTHER_MAX_LEN = 100;

const isMessagingToolId = (
  v: string | null | undefined,
): v is MessagingToolId => MESSAGING_TOOL_OPTIONS.some((o) => o.id === v);

/** Step 1 is ONE question: which messaging tool the team uses. Slack starts
 * selected; "Other" asks which one. Skippable: an unanswered survey question
 * must never hold the product hostage. */
export default function WelcomePage() {
  const router = useRouter();
  const { progress } = useOnboarding();
  const [tool, setTool] = useState<MessagingToolId>(() =>
    isMessagingToolId(progress.messagingTool)
      ? progress.messagingTool
      : DEFAULT_MESSAGING_TOOL,
  );
  const [other, setOther] = useState(progress.messagingToolOther ?? "");
  const { leaving, leave } = useScreenExit();
  const leaveTo = (path: string) => leave(() => router.push(path));

  useEffect(() => {
    router.prefetch(onboardingPath("create"));
  }, [router]);

  const otherMissing = tool === "other" && other.trim().length === 0;

  const handleContinue = () => {
    // Fire-and-forget: an unsaved survey answer must never hold the product
    // hostage. `void` alone would leave a network-level rejection unhandled.
    saveOnboardingProgress({
      messagingTool: tool,
      messagingToolOther: tool === "other" ? other.trim() : null,
    }).catch(() => {});
    leaveTo(onboardingPath("create"));
  };

  const handleSkip = () => leaveTo(onboardingPath("create"));

  return (
    <div
      className={cn(
        "flex w-full max-w-2xl flex-col items-center transition-[opacity,transform] duration-300 ease-in",
        leaving && "pointer-events-none -translate-y-1 opacity-0",
      )}
    >
      <h1 className="text-center font-serif text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        Which messaging tool does your team use?
      </h1>

      <div className="mt-8 w-full">
        <WelcomeMessagingSection selected={tool} onSelect={setTool} />
      </div>

      {/* A fixed slot for the "Other" field: always reserved, filled only
          when Other is picked, so the buttons below never move. */}
      <div className="mt-4 flex h-10 w-full justify-center">
        {tool === "other" && (
          <div className="motion-safe:animate-in motion-safe:fade-in w-full max-w-sm">
            <Input
              aria-label="Which messaging tool?"
              placeholder="Which one?"
              value={other}
              maxLength={OTHER_MAX_LEN}
              autoFocus
              onChange={(e) => setOther(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !otherMissing) handleContinue();
              }}
            />
          </div>
        )}
      </div>

      <div className="mt-10 flex items-center justify-center gap-2">
        <Button variant="ghost" size="lg" onClick={handleSkip}>
          Skip
        </Button>
        <Button
          variant="brand"
          size="lg"
          onClick={handleContinue}
          disabled={otherMissing}
        >
          Continue
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
