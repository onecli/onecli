"use client";

import { useState } from "react";
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
import { deleteRule, updateRule } from "@/lib/actions/rules";
import { RuleDialog } from "./rule-dialog";
import type { AgentOption, PolicyRuleItem } from "./rules-content";

interface RuleCardProps {
  rule: PolicyRuleItem;
  agents: AgentOption[];
  onUpdate: () => void;
}

export const RuleCard = ({ rule, agents, onUpdate }: RuleCardProps) => {
  const [deleting, setDeleting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [toggling, setToggling] = useState(false);

  const agentName = rule.agentId
    ? agents.find((a) => a.id === rule.agentId)?.name
    : null;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteRule(rule.id);
      onUpdate();
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
      onUpdate();
    } catch {
      toast.error("Failed to update rule");
    } finally {
      setToggling(false);
    }
  };

  return (
    <>
      <Card
        className={`p-5 transition-opacity ${!rule.enabled ? "opacity-50" : ""}`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">{rule.name}</h3>
              <Badge variant="destructive" className="text-xs">
                {rule.action}
              </Badge>
              {rule.method && (
                <Badge variant="outline" className="font-mono text-xs">
                  {rule.method}
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
        </div>
      </Card>

      <RuleDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        rule={rule}
        agents={agents}
        onSaved={onUpdate}
      />
    </>
  );
};
