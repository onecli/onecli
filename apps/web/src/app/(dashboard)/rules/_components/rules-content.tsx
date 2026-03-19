"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, ShieldOff } from "lucide-react";
import { getRules } from "@/lib/actions/rules";
import { getAgents } from "@/lib/actions/agents";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { RuleCard } from "./rule-card";
import { RuleDialog } from "./rule-dialog";

export interface PolicyRuleItem {
  id: string;
  name: string;
  hostPattern: string;
  pathPattern: string | null;
  method: string | null;
  action: string;
  enabled: boolean;
  agentId: string | null;
  createdAt: Date;
}

export interface AgentOption {
  id: string;
  name: string;
}

export const RulesContent = () => {
  const [rules, setRules] = useState<PolicyRuleItem[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const fetchRules = useCallback(async () => {
    const result = await getRules();
    setRules(result);
    setLoading(false);
  }, []);

  const fetchAgents = useCallback(async () => {
    const result = await getAgents();
    setAgents(result.map((a) => ({ id: a.id, name: a.name })));
  }, []);

  useEffect(() => {
    fetchRules();
    fetchAgents();
  }, [fetchRules, fetchAgents]);

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card key={i} className="p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-4 w-32" />
              </div>
              <div className="flex gap-2">
                <Skeleton className="h-5 w-9 rounded-full" />
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
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" />
          New Rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-amber-500/10">
            <ShieldOff className="size-6 text-amber-500" />
          </div>
          <p className="text-sm font-medium">YOLO mode</p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            Your agents have unrestricted access to all assigned secrets. Add a
            rule to block specific endpoints or set boundaries.
          </p>
        </Card>
      ) : (
        rules.map((rule) => (
          <RuleCard
            key={rule.id}
            rule={rule}
            agents={agents}
            onUpdate={fetchRules}
          />
        ))
      )}

      <RuleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={fetchRules}
        agents={agents}
      />
    </div>
  );
};
