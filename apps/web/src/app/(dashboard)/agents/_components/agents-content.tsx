"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Bot } from "lucide-react";
import { useAuth } from "@/providers/auth-provider";
import { getAgents } from "@/lib/actions/agents";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { AgentCard } from "./agent-card";
import { CreateAgentDialog } from "./create-agent-dialog";

interface Agent {
  id: string;
  name: string;
  accessToken: string;
  isDefault: boolean;
  createdAt: Date;
}

export const AgentsContent = () => {
  const { user } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const fetchAgents = useCallback(async () => {
    if (!user?.id) return;
    const result = await getAgents(user.id);
    setAgents(result);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

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
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">Coming soon</span>
          <Button size="sm" disabled>
            <Plus className="size-3.5" />
            Create Agent
          </Button>
        </div>
      </div>

      {agents.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
            <Bot className="text-muted-foreground size-6" />
          </div>
          <p className="text-sm font-medium">No agents yet</p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            Create an agent to generate an access token for connecting to the
            proxy.
          </p>
        </Card>
      ) : (
        agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} onUpdate={fetchAgents} />
        ))
      )}

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={fetchAgents}
      />
    </div>
  );
};
