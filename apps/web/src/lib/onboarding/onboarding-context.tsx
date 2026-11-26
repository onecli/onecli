"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { OnboardingProgress } from "./steps";
import { DEFAULT_AGENT_NAME } from "./steps";
import { completeOnboarding, saveOnboardingProgress } from "./actions";
import { getActiveWorkspacePath } from "@/lib/workspaces/actions";
import { useCreateHostedAgent } from "@/hooks/use-agents";
import { useOpenDirectThread } from "@/hooks/use-conversations";

interface OnboardingContextValue {
  /** Where the created agent lives — set once creation succeeds. */
  createdAgentId: string | null;
  createdAgentName: string | null;
  /** The default workspace the flow creates into, resolved at layout boot —
   * present from the first render, so resume paths reach the chat too. */
  workspaceId: string;
  /**
   * Make the flow's agent exist, as `DEFAULT_AGENT_NAME`, and start its
   * machine: the welcome step calls this on mount so the whole welcome dwell
   * is boot time. Idempotent (a created or in-flight agent is kept), and
   * quiet: a refusal here (quota, no runner) is swallowed, and the name
   * step's own create-on-submit is the fallback that reports it.
   */
  ensureAgent: () => void;
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

  const createAgent = useCreateHostedAgent();
  const openThread = useOpenDirectThread();
  // One create per provider life: the welcome step mounts twice under
  // StrictMode and again on a back-navigation, and each must find the first
  // in flight rather than mint a second agent.
  const ensuringRef = useRef(false);

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

  const { mutateAsync: create } = createAgent;
  const { mutate: open } = openThread;
  const ensureAgent = useCallback(() => {
    if (createdAgentId || ensuringRef.current) return;
    ensuringRef.current = true;
    const run = async () => {
      const agent = await create({
        name: DEFAULT_AGENT_NAME,
        workspaceId: initialWorkspaceId,
      });
      setCreatedAgentId(agent.id);
      setCreatedAgentName(agent.name);
      // The greeting's door checks the survey's `createdAgentId`, so the
      // save must land BEFORE the thread opens, or the greeting is skipped
      // as "not the onboarding agent". Awaited here for exactly that; the
      // flow itself never waits on it.
      await saveOnboardingProgress({
        createdAgentId: agent.id,
        agentName: agent.name,
      });
      open({ agentId: agent.id, workspaceId: initialWorkspaceId });
    };
    run().catch(() => {
      // Quiet by design: the name step creates on submit and reports the
      // refusal with its own copy. Re-armed so that fallback (and a later
      // welcome mount) may try again.
      ensuringRef.current = false;
    });
  }, [createdAgentId, create, open, initialWorkspaceId]);

  // A resumed flow with an agent that already exists: open its thread so
  // the greeting is in flight while the person finishes the flow.
  const resumedAgentId = initialProgress.createdAgentId ?? null;
  useEffect(() => {
    if (resumedAgentId)
      open({ agentId: resumedAgentId, workspaceId: initialWorkspaceId });
  }, [resumedAgentId, open, initialWorkspaceId]);

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
        ensureAgent,
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
