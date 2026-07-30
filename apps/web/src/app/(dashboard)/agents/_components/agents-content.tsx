"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, Bot } from "lucide-react";
import { useAgents } from "@/hooks/use-agents";
import { useGrantsSummary } from "@/hooks/use-grants";
import { agentPath } from "@/lib/navigation";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { AgentCard } from "./agent-card";
import { CreateAgentDialog } from "./create-agent-dialog";

interface AgentsContentProps {
  renderCreateButton?: (onCreate: () => void) => React.ReactNode;
}

export const AgentsContent = ({
  renderCreateButton,
}: AgentsContentProps = {}) => {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const manageAgentId = searchParams.get("manage");
  const { data: agents = [], isPending: loading } = useAgents();
  const { data: summaries = [] } = useGrantsSummary();
  const [createOpen, setCreateOpen] = useState(false);

  // `?manage=<id-prefix>` (attach-model step 3): the deep link lands on the
  // agent detail page — the attach surfaces live there now. Prefix matching
  // preserved from the old dialog-opening behavior; one-shot per mount.
  const redirected = useRef(false);
  useEffect(() => {
    if (redirected.current || !manageAgentId || agents.length === 0) return;
    const target = agents.find((a) => a.id.startsWith(manageAgentId));
    if (!target) return;
    redirected.current = true;
    router.replace(agentPath(pathname, target.id));
  }, [manageAgentId, agents, router, pathname]);

  const summaryByAgent = new Map(summaries.map((s) => [s.id, s.grantsSummary]));

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card key={i} className="p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
              <div className="flex gap-2">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="size-8 rounded-md" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {renderCreateButton ? (
          renderCreateButton(() => setCreateOpen(true))
        ) : (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            Create Agent
          </Button>
        )}
      </div>

      {agents.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
            <Bot className="text-muted-foreground size-6" />
          </div>
          <p className="text-sm font-medium">No agents yet</p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            Create an agent to generate an access token for connecting to the
            gateway.
          </p>
        </Card>
      ) : (
        agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            summary={summaryByAgent.get(agent.id)}
          />
        ))
      )}

      <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
};
