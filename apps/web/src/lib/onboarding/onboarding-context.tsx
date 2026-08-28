"use client";

import { createContext, useContext, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { OnboardingProgress } from "./steps";
import { completeOnboarding, saveOnboardingProgress } from "./actions";
import { getActiveWorkspacePath } from "@/lib/workspaces/actions";

interface OnboardingContextValue {
  /** Where the created agent lives — set once creation succeeds. */
  createdAgentId: string | null;
  createdAgentName: string | null;
  /** The default workspace the flow creates into, resolved at layout boot —
   * present from the first render, so resume paths reach the chat too. */
  workspaceId: string;
  recordCreatedAgent: (data: { agentId: string; agentName: string }) => void;
  completing: boolean;
  /** Finish onboarding and land in the created agent's chat (or the
   * dashboard when no agent was created — the skip path). */
  handleComplete: (destination?: string) => Promise<void>;
  progress: OnboardingProgress;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export const OnboardingProvider = ({
  initialProgress,
  initialWorkspaceId,
  children,
}: {
  initialProgress: OnboardingProgress;
  initialWorkspaceId: string;
  children: React.ReactNode;
}) => {
  const router = useRouter();
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(
    initialProgress.createdAgentId ?? null,
  );
  const [createdAgentName, setCreatedAgentName] = useState<string | null>(
    initialProgress.agentName,
  );
  const [completing, setCompleting] = useState(false);
  // One completion per session — a double-click must not double-notify.
  const completedRef = useRef(false);

  const progress = useMemo<OnboardingProgress>(
    () => ({
      ...initialProgress,
      agentName: createdAgentName,
      createdAgentId,
    }),
    [initialProgress, createdAgentName, createdAgentId],
  );

  const recordCreatedAgent = (data: { agentId: string; agentName: string }) => {
    setCreatedAgentId(data.agentId);
    setCreatedAgentName(data.agentName);
    // Fire-and-forget: resume support, never blocks the flow. `void` alone
    // would leave a network-level rejection unhandled.
    saveOnboardingProgress({
      createdAgentId: data.agentId,
      agentName: data.agentName,
    }).catch(() => {});
  };

  const handleComplete = async (destination?: string) => {
    if (completedRef.current) return;
    setCompleting(true);
    try {
      const result = await completeOnboarding({
        createdAgentId,
        agentName: createdAgentName,
      });
      if (!result.ok) {
        toast.error(result.error);
        setCompleting(false);
        return;
      }
      completedRef.current = true;
      // The fallback resolve is not a cheap read (it lazily ensures the
      // default org/workspace) — only pay for it on the skip path, where no
      // destination was handed in.
      router.replace(destination ?? (await getActiveWorkspacePath()));
    } catch {
      toast.error("Something went wrong.");
      setCompleting(false);
    }
  };

  return (
    <OnboardingContext.Provider
      value={{
        createdAgentId,
        createdAgentName,
        workspaceId: initialWorkspaceId,
        recordCreatedAgent,
        completing,
        handleComplete,
        progress,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
};

export const useOnboarding = (): OnboardingContextValue => {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error("useOnboarding must be used within OnboardingProvider");
  }
  return context;
};
