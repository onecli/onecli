"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Plus, Settings2, Shield, ShieldOff } from "lucide-react";
import { rules as rulesApi } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { useAgents } from "@/hooks/use-agents";
import { useConnections } from "@/hooks/use-connections";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { Separator } from "@onecli/ui/components/separator";
import { RuleCard } from "./rule-card";
import { RuleDialog } from "./rule-dialog";
import { AppPermissionSummary } from "./app-permission-summary";
import type { PolicyMode } from "@onecli/api/validations/policy-rule";
import type { AgentOption, PolicyRuleItem, RuleActions } from "./types";
export type { PolicyRuleItem, AgentOption, RuleActions } from "./types";

interface RulesContentProps {
  getRules?: () => Promise<PolicyRuleItem[]>;
  ruleActions?: RuleActions;
  pageScope?: "project" | "organization";
  showAgentField?: boolean;
  policyMode?: PolicyMode;
  settingsHref?: string;
}

const isAppPermissionRule = (rule: PolicyRuleItem) =>
  rule.metadata != null &&
  typeof rule.metadata === "object" &&
  "source" in rule.metadata &&
  rule.metadata.source === "app_permission";

export const RulesContent = ({
  getRules,
  ruleActions,
  pageScope = "project",
  showAgentField = true,
  policyMode = "allow",
  settingsHref,
}: RulesContentProps) => {
  const isDenyMode = policyMode === "deny";
  const { data: rules = [], isPending: loading } = useQuery<PolicyRuleItem[]>({
    queryKey: [...queryKeys.rules.list(), pageScope],
    queryFn: (getRules ?? rulesApi.list) as () => Promise<PolicyRuleItem[]>,
  });
  const { data: agentsList = [] } = useAgents();
  const agents: AgentOption[] = useMemo(
    () => agentsList.map((a) => ({ id: a.id, name: a.name })),
    [agentsList],
  );
  const { data: connectionsList = [] } = useConnections();
  const connectedProviders = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of connectionsList) {
      if (c.status !== "connected") continue;
      const labels = map.get(c.provider) ?? [];
      if (c.label) labels.push(c.label);
      map.set(c.provider, labels);
    }
    return map;
  }, [connectionsList]);
  const [createOpen, setCreateOpen] = useState(false);

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
          {isDenyMode ? (
            <>
              <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-blue-500/10">
                <Shield className="size-6 text-blue-500" />
              </div>
              <p className="text-sm font-medium">Lockdown mode</p>
              <p className="text-muted-foreground mt-1 max-w-xs text-xs">
                All traffic is blocked by default. Add an allow rule to permit
                specific endpoints your agents need.
              </p>
            </>
          ) : (
            <>
              <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-amber-500/10">
                <ShieldOff className="size-6 text-amber-500" />
              </div>
              <p className="text-sm font-medium">YOLO mode</p>
              <p className="text-muted-foreground mt-1 max-w-xs text-xs">
                Your agents have unrestricted access to all assigned secrets.
                Add a rule to block specific endpoints or set boundaries.
              </p>
            </>
          )}
          {settingsHref && (
            <Link
              href={settingsHref}
              className="text-muted-foreground hover:text-foreground mt-4 inline-flex items-center gap-1.5 text-xs transition-colors"
            >
              <Settings2 className="size-3" />
              Change policy mode
            </Link>
          )}
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
                  readOnly={isInherited(rule)}
                  badge={isInherited(rule) ? "Organization" : undefined}
                  ruleActions={ruleActions}
                  policyMode={policyMode}
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
                connectedProviders={connectedProviders}
              />
            </>
          )}
        </>
      )}

      <RuleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        agents={showAgentField ? agents : []}
        showAgentField={showAgentField}
        ruleActions={ruleActions}
        connectedProviders={connectedProviders}
        policyMode={policyMode}
      />
    </div>
  );
};
