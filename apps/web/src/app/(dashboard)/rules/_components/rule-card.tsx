"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { queryKeys } from "@/lib/api/keys";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Badge } from "@onecli/ui/components/badge";
import { Switch } from "@onecli/ui/components/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@onecli/ui/components/alert-dialog";
import {
  deleteRule as defaultDeleteRule,
  updateRule as defaultUpdateRule,
} from "@/lib/actions/rules";
import { cn } from "@onecli/ui/lib/utils";
import { RuleDialog } from "./rule-dialog";
import type { PolicyMode } from "@onecli/api/validations/policy-rule";
import type { AgentOption, PolicyRuleItem, RuleActions } from "./types";

interface RuleCardProps {
  rule: PolicyRuleItem;
  agents: AgentOption[];
  onUpdate?: () => void;
  readOnly?: boolean;
  badge?: string;
  ruleActions?: RuleActions;
  policyMode?: PolicyMode;
}

export const RuleCard = ({
  rule,
  agents,
  onUpdate,
  readOnly,
  badge,
  ruleActions,
  policyMode,
}: RuleCardProps) => {
  const deleteRule = ruleActions?.deleteRule ?? defaultDeleteRule;
  const updateRule = ruleActions?.updateRule ?? defaultUpdateRule;
  const invalidateCache = useInvalidateGatewayCache();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [toggling, setToggling] = useState(false);

  const agentName = rule.agentId
    ? agents.find((a) => a.id === rule.agentId)?.name
    : null;

  const actionLabel =
    rule.action === "rate_limit"
      ? "rate limit"
      : rule.action === "manual_approval"
        ? "manual approval"
        : rule.action;

  const rateLimitLabel =
    rule.action === "rate_limit" && rule.rateLimit && rule.rateLimitWindow
      ? `${rule.rateLimit}/${
          { minute: "min", hour: "hr", day: "day" }[rule.rateLimitWindow] ??
          rule.rateLimitWindow
        }`
      : null;

  const invalidateRulesCache = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.rules.all() });
    queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteRule(rule.id);
      invalidateRulesCache();
      onUpdate?.();
      invalidateCache();
      toast.success("Rule deleted");
    } catch {
      toast.error("Failed to delete rule");
    } finally {
      setDeleting(false);
    }
  };

  const handleToggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await updateRule(rule.id, { enabled });
      invalidateRulesCache();
      onUpdate?.();
      invalidateCache();
    } catch {
      toast.error("Failed to update rule");
    } finally {
      setToggling(false);
    }
  };

  return (
    <>
      <Card
        className={cn(
          "p-5 transition-opacity",
          !rule.enabled && "opacity-50",
          readOnly && "opacity-60 border-dashed",
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">{rule.name}</h3>
              <Badge
                variant={
                  rule.action === "rate_limit" ||
                  rule.action === "manual_approval" ||
                  rule.action === "allow"
                    ? "secondary"
                    : "destructive"
                }
                className={`text-xs ${rule.action === "rate_limit" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : rule.action === "manual_approval" ? "bg-blue-500/15 text-blue-600 dark:text-blue-400" : rule.action === "allow" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : ""}`}
              >
                {actionLabel}
              </Badge>
              {rule.method && (
                <Badge variant="outline" className="font-mono text-xs">
                  {rule.method}
                </Badge>
              )}
              {rateLimitLabel && (
                <Badge
                  variant="outline"
                  className="text-muted-foreground text-xs"
                >
                  {rateLimitLabel}
                </Badge>
              )}
              {(() => {
                const cond = Array.isArray(rule.conditions)
                  ? (rule.conditions[0] as { value?: string } | undefined)
                  : undefined;
                return cond?.value ? (
                  <Badge
                    variant="outline"
                    className="text-[10px] font-normal text-muted-foreground"
                  >
                    when body contains &ldquo;{cond.value}&rdquo;
                  </Badge>
                ) : null;
              })()}
              {badge && (
                <Badge variant="outline" className="text-[10px]">
                  {badge}
                </Badge>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">
                Host:{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono">
                  {rule.hostPattern}
                </code>
              </span>
              {rule.pathPattern && (
                <span className="text-muted-foreground">
                  Path:{" "}
                  <code className="bg-muted rounded px-1 py-0.5 font-mono">
                    {rule.pathPattern}
                  </code>
                </span>
              )}
              <span className="text-muted-foreground">
                Scope:{" "}
                {agentName ? (
                  <span className="text-foreground">{agentName}</span>
                ) : (
                  "All agents"
                )}
              </span>
            </div>
          </div>

          {!readOnly && (
            <div className="flex items-center gap-2">
              <Switch
                checked={rule.enabled}
                onCheckedChange={handleToggle}
                disabled={toggling}
                aria-label={rule.enabled ? "Disable rule" : "Enable rule"}
              />

              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setEditOpen(true)}
              >
                <Pencil className="size-3.5" />
              </Button>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7">
                    <Trash2 className="size-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete rule?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete <strong>{rule.name}</strong>.
                      This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={handleDelete}
                      disabled={deleting}
                    >
                      {deleting ? "Deleting..." : "Delete"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>
      </Card>

      {!readOnly && (
        <RuleDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          rule={rule}
          agents={agents}
          onSaved={onUpdate}
          ruleActions={ruleActions}
          policyMode={policyMode}
        />
      )}
    </>
  );
};
