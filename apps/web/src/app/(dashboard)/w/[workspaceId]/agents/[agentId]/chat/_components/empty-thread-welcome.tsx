"use client";

import { Sparkles } from "lucide-react";
import { useAgentModels } from "@/hooks/use-agents";
import { GreetingConnectCard } from "./greeting-connect-card";

/**
 * What a brand-new thread shows when the agent has not spoken.
 *
 * The agent speaks first in exactly ONE thread: the one with the agent
 * onboarding created (greeting-service posts an instruction and the agent
 * answers it live). Every other new thread lands here — an agent created
 * later from the dashboard, or an account with no model key yet, which is
 * precisely the state a brand-new user is in. The honest move in both cases
 * is to speak in the PRODUCT's voice rather than to fabricate a reply in the
 * agent's. Words the agent never said must never appear in the agent's
 * bubble: this is a page, not a message, and it reads as one.
 *
 * It disappears the moment any turn exists, including the greeting the
 * onboarding agent posts once a key lands.
 */
export const EmptyThreadWelcome = ({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) => {
  // WHY the thread is empty decides what to say. No key is the onboarding
  // case and has a next step worth naming; with a key the thread is simply
  // new (the greeting may still be on its way, or this agent was created
  // before greetings existed), and telling that person to connect a key
  // would be wrong. `provider: null` is the server's own "nothing to run
  // with" answer — the same predicate the greeting gated on. An unresolved
  // query says neither: the neutral line is true in both worlds.
  const { data: models } = useAgentModels(agentId);
  const needsKey = models !== undefined && models.provider === null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 py-10 text-center">
      <div className="bg-brand/10 flex size-10 items-center justify-center rounded-full">
        <Sparkles className="text-brand size-5" aria-hidden />
      </div>
      <div>
        <p className="text-sm font-medium text-balance">
          {agentName} is ready when you are
        </p>
        <p className="text-muted-foreground mt-1 text-xs text-pretty">
          {needsKey
            ? "Connect a model key from Models and it can start answering here."
            : "Say hello, or hand it something to do."}
        </p>
      </div>
      {/* The same first-connection picks the greeting card offers — a new
          thread is a new thread whether or not the agent could speak in it. */}
      <GreetingConnectCard />
    </div>
  );
};
