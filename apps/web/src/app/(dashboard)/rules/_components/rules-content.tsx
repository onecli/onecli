"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, ShieldOff } from "lucide-react";
import { getRules as defaultGetRules } from "@/lib/actions/rules";
import { getAgents } from "@/lib/actions/agents";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { Separator } from "@onecli/ui/components/separator";
import { RuleCard } from "./rule-card";
import { RuleDialog } from "./rule-dialog";
import { AppPermissionSummary } from "./app-permission-summary";
import type { AgentOption, PolicyRuleItem, RuleActions } from "./types";
export type { PolicyRuleItem, AgentOption, RuleActions } from "./types";

interface RulesContentProps {
  getRules?: () => Promise<PolicyRuleItem[]>;
  ruleActions?: RuleActions;
  pageScope?: "project" | "organization";
  showAgentField?: boolean;
}

const isAppPermissionRule = (rule: PolicyRuleItem) =>
  rule.metadata != null &&
  typeof rule.metadata === "object" &&
  "source" in rule.metadata &&
  rule.metadata.source === "app_permission";

export const RulesContent = ({
  getRules = defaultGetRules,
  ruleActions,
  pageScope = "project",
  showAgentField = true,
}: RulesContentProps) => {
  const [rules, setRules] = useState<PolicyRuleItem[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const fetchRules = useCallback(async () => {
    const result = await getRules();
    setRules(result);
    setLoading(false);
  }, [getRules]);

  const fetchAgents = useCallback(async () => {
    const result = await getAgents();
    setAgents(result.map((a) => ({ id: a.id, name: a.name })));
  }, []);

  useEffect(() => {
    fetchRules();
    if (showAgentField) fetchAgents();
  }, [fetchRules, fetchAgents, showAgentField]);

  const isInherited = (r: PolicyRuleItem) =>
    r.scope != null && r.scope !== pageScope;

  const ownRules: PolicyRuleItem[] = [];
  const inheritedRules: PolicyRuleItem[] = [];
  const appPermRules: PolicyRuleItem[] = [];

  for (const r of rules) {
    if (isAppPermissionRule(r)) {
      appPermRules.push(r);
    } else if (isInherited(r)) {
      inheritedRules.push(r);
    } else {
      ownRules.push(r);
    }
  }

  const customRules = [...ownRules, ...inheritedRules];

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

      {customRules.length === 0 && appPermRules.length === 0 ? (
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
        <>
          {customRules.length > 0 && (
            <div className="space-y-3">
              {customRules.map((rule) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  agents={agents}
                  onUpdate={fetchRules}
                  readOnly={isInherited(rule)}
                  badge={isInherited(rule) ? "Organization" : undefined}
                  ruleActions={ruleActions}
                />
              ))}
            </div>
          )}

          {appPermRules.length > 0 && (
            <>
              {customRules.length > 0 && (
                <div className="flex items-center gap-3 pt-2">
                  <Separator className="flex-1" />
                  <span className="text-xs text-muted-foreground shrink-0">
                    App permissions
                  </span>
                  <Separator className="flex-1" />
                </div>
              )}
              <AppPermissionSummary
                rules={appPermRules}
                pageScope={pageScope}
              />
            </>
          )}
        </>
      )}

      <RuleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={fetchRules}
        agents={showAgentField ? agents : []}
        showAgentField={showAgentField}
        ruleActions={ruleActions}
      />
    </div>
  );
};
