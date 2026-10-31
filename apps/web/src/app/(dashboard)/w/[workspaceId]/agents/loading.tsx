import { PageHeader } from "@dashboard/page-header";
import { AgentsDoorSkeleton } from "./_components/agents-door-skeleton";

export default function AgentsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Agents"
        description="Create an agent to get started."
      />
      <AgentsDoorSkeleton />
    </div>
  );
}
