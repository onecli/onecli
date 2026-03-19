"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { ShieldBan, Eye, UserCheck, Settings2, Gauge } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Checkbox } from "@onecli/ui/components/checkbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@onecli/ui/components/accordion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { createRule, updateRule } from "@/lib/actions/rules";
import type { AgentOption, PolicyRuleItem } from "./rules-content";

const METHOD_OPTIONS = [
  { value: "", label: "All methods" },
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
  { value: "DELETE", label: "DELETE" },
] as const;

interface RuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  agents: AgentOption[];
  /** Pass an existing rule to edit. Omit for create mode. */
  rule?: PolicyRuleItem;
}

export const RuleDialog = ({
  open,
  onOpenChange,
  onSaved,
  agents,
  rule,
}: RuleDialogProps) => {
  const isEdit = !!rule;
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [hostPattern, setHostPattern] = useState("");
  const [pathPattern, setPathPattern] = useState("");
  const [method, setMethod] = useState("");
  const [agentId, setAgentId] = useState("");
  const [enabled, setEnabled] = useState(true);

  // Reset form when dialog opens or rule changes
  useEffect(() => {
    if (open) {
      setName(rule?.name ?? "");
      setHostPattern(rule?.hostPattern ?? "");
      setPathPattern(rule?.pathPattern ?? "");
      setMethod(rule?.method ?? "");
      setAgentId(rule?.agentId ?? "");
      setEnabled(rule?.enabled ?? true);
    }
  }, [open, rule]);

  const isValid = name.trim() && hostPattern.trim();

  const hasChanges = isEdit
    ? name.trim() !== rule.name ||
      hostPattern.trim() !== rule.hostPattern ||
      (pathPattern.trim() || null) !== rule.pathPattern ||
      (method || null) !== rule.method ||
      (agentId || null) !== rule.agentId
    : true;

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    try {
      if (isEdit) {
        await updateRule(rule.id, {
          name: name.trim(),
          hostPattern: hostPattern.trim(),
          pathPattern: pathPattern.trim() || null,
          method:
            (method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE") || null,
          agentId: agentId || null,
        });
        toast.success("Rule updated");
      } else {
        await createRule({
          name: name.trim(),
          hostPattern: hostPattern.trim(),
          pathPattern: pathPattern.trim() || undefined,
          method:
            (method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE") ||
            undefined,
          action: "block" as const,
          enabled,
          agentId: agentId || undefined,
        });
        toast.success("Rule created");
      }
      onSaved();
      handleClose(false);
    } catch {
      toast.error(isEdit ? "Failed to update rule" : "Failed to create rule");
    } finally {
      setSaving(false);
    }
  };

  const handleClose = (value: boolean) => {
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit rule" : "New rule"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the conditions for this policy rule."
              : "Block agents from accessing specific API endpoints."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              placeholder="e.g. Block Gmail send"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="rule-host">Host pattern</Label>
            <Input
              id="rule-host"
              placeholder="e.g. gmail.googleapis.com"
              value={hostPattern}
              onChange={(e) => setHostPattern(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Use <code className="text-xs">*.example.com</code> for wildcard
              subdomains.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="rule-path">
              Path pattern{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </Label>
            <Input
              id="rule-path"
              placeholder="e.g. /gmail/v1/users/me/messages/send"
              value={pathPattern}
              onChange={(e) => setPathPattern(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Use <code className="text-xs">/path/*</code> for prefix matching.
              Leave empty to match all paths on this host.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Method</Label>
              <Select
                value={method || "_all"}
                onValueChange={(v) => setMethod(v === "_all" ? "" : v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHOD_OPTIONS.map((opt) => (
                    <SelectItem
                      key={opt.value || "_all"}
                      value={opt.value || "_all"}
                    >
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Scope</Label>
              <Select
                value={agentId || "_all"}
                onValueChange={(v) => setAgentId(v === "_all" ? "" : v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all">All agents</SelectItem>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Action</Label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                className="border-primary bg-primary/5 flex flex-col gap-1 rounded-md border p-2.5 text-left"
              >
                <span className="flex items-center gap-2 text-xs font-medium">
                  <ShieldBan className="text-primary size-3.5" />
                  Block
                </span>
                <span className="text-muted-foreground text-[10px] leading-tight">
                  Deny the request
                </span>
              </button>
              <button
                type="button"
                disabled
                className="flex flex-col gap-1 rounded-md border p-2.5 text-left opacity-50"
              >
                <span className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2">
                    <Eye className="size-3.5" />
                    Monitor
                  </span>
                  <Badge
                    variant="secondary"
                    className="px-1 py-0 text-[9px] leading-4"
                  >
                    Soon
                  </Badge>
                </span>
                <span className="text-muted-foreground text-[10px] leading-tight">
                  Allow &amp; notify
                </span>
              </button>
              <button
                type="button"
                disabled
                className="flex flex-col gap-1 rounded-md border p-2.5 text-left opacity-50"
              >
                <span className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2">
                    <UserCheck className="size-3.5" />
                    Approval
                  </span>
                  <Badge
                    variant="secondary"
                    className="px-1 py-0 text-[9px] leading-4"
                  >
                    Soon
                  </Badge>
                </span>
                <span className="text-muted-foreground text-[10px] leading-tight">
                  Require human review before allowing
                </span>
              </button>
            </div>
          </div>

          <Accordion type="single" collapsible className="border-none">
            <AccordionItem value="advanced" className="border-t border-b-0">
              <AccordionTrigger className="py-3 hover:no-underline">
                <span className="text-muted-foreground flex items-center gap-2 text-xs font-normal">
                  <Settings2 className="size-3.5" />
                  Advanced settings
                </span>
              </AccordionTrigger>
              <AccordionContent className="pb-0">
                <div className="space-y-4">
                  {!isEdit && (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="rule-enabled"
                        checked={enabled}
                        onCheckedChange={(checked) =>
                          setEnabled(checked === true)
                        }
                      />
                      <Label
                        htmlFor="rule-enabled"
                        className="text-sm font-normal"
                      >
                        Enable rule immediately
                      </Label>
                    </div>
                  )}

                  <div className="flex items-start gap-3 rounded-md border p-3 opacity-50">
                    <Gauge className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">Rate limit</span>
                        <Badge
                          variant="secondary"
                          className="px-1 py-0 text-[9px] leading-4"
                        >
                          Soon
                        </Badge>
                      </div>
                      <p className="text-muted-foreground text-[11px] leading-snug">
                        Limit how many requests per hour can pass through this
                        rule. Excess requests will be blocked.
                      </p>
                    </div>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={saving}
            disabled={!isValid || (isEdit && !hasChanges)}
          >
            {saving
              ? isEdit
                ? "Saving..."
                : "Creating..."
              : isEdit
                ? "Save Changes"
                : "Create Rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
