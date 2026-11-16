import { PageHeader } from "@dashboard/page-header";
import { AgentsDoorSkeleton } from "../_components/agents-door-skeleton";

/**
 * The agents LIST's loading screen. It lives in the `(list)` group, not at
 * `agents/`, on purpose: a `loading.tsx` at `agents/` also wraps every
 * `agents/[agentId]` page, so switching agents flashed this "Agents" header
 * and skeleton over the whole page before the next agent painted.
 */
export default function AgentsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Agents"
        character="drop"
        description="Create an agent to get started."
      />
      <AgentsDoorSkeleton />
    </div>
  );
}
