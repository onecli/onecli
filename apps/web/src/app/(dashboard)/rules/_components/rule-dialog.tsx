"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { ShieldBan, Settings2, Gauge } from "lucide-react";
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
  const [action, setAction] = useState<"block" | "rate_limit">("block");
  const [rateLimit, setRateLimit] = useState(100);
  const [rateLimitWindow, setRateLimitWindow] = useState<
    "minute" | "hour" | "day"
  >("hour");
  const [enabled, setEnabled] = useState(true);

  // Reset form when dialog opens or rule changes
  useEffect(() => {
    if (open) {
      setName(rule?.name ?? "");
      setHostPattern(rule?.hostPattern ?? "");
      setPathPattern(rule?.pathPattern ?? "");
      setMethod(rule?.method ?? "");
      setAgentId(rule?.agentId ?? "");
      setAction((rule?.action as "block" | "rate_limit") ?? "block");
      setRateLimit(rule?.rateLimit ?? 100);
      setRateLimitWindow(
        (rule?.rateLimitWindow as "minute" | "hour" | "day") ?? "hour",
      );
      setEnabled(rule?.enabled ?? true);
    }
  }, [open, rule]);

  const isValid =
    name.trim() &&
    hostPattern.trim() &&
    (action !== "rate_limit" || (rateLimit > 0 && rateLimitWindow));

  const hasChanges = isEdit
    ? name.trim() !== rule.name ||
      hostPattern.trim() !== rule.hostPattern ||
      (pathPattern.trim() || null) !== rule.pathPattern ||
      (method || null) !== rule.method ||
      (agentId || null) !== rule.agentId ||
      action !== rule.action ||
      (action === "rate_limit" &&
        (rateLimit !== rule.rateLimit ||
          rateLimitWindow !== rule.rateLimitWindow))
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
          action,
          rateLimit: action === "rate_limit" ? rateLimit : null,
          rateLimitWindow: action === "rate_limit" ? rateLimitWindow : null,
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
          action,
          enabled,
          agentId: agentId || undefined,
          rateLimit: action === "rate_limit" ? rateLimit : undefined,
          rateLimitWindow:
            action === "rate_limit" ? rateLimitWindow : undefined,
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit rule" : "New rule"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the conditions for this policy rule."
              : "Control what your agents can do with specific endpoints."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              placeholder="e.g. Limit Anthropic calls"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="rule-host">Host pattern</Label>
              <Input
                id="rule-host"
                placeholder="e.g. api.anthropic.com"
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
                placeholder="e.g. /v1/messages"
                value={pathPattern}
                onChange={(e) => setPathPattern(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Use <code className="text-xs">/path/*</code> for prefix
                matching.
              </p>
            </div>
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
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAction("block")}
                className={`flex flex-col gap-1 rounded-md border p-2.5 text-left transition-colors ${
                  action === "block"
                    ? "border-primary bg-primary/5"
                    : "hover:bg-muted/50"
                }`}
              >
                <span className="flex items-center gap-2 text-xs font-medium">
                  <ShieldBan
                    className={`size-3.5 ${action === "block" ? "text-primary" : ""}`}
                  />
                  Block
                </span>
                <span className="text-muted-foreground text-[10px] leading-tight">
                  Deny the request
                </span>
              </button>
              <button
                type="button"
                onClick={() => setAction("rate_limit")}
                className={`flex flex-col gap-1 rounded-md border p-2.5 text-left transition-colors ${
                  action === "rate_limit"
                    ? "border-primary bg-primary/5"
                    : "hover:bg-muted/50"
                }`}
              >
                <span className="flex items-center gap-2 text-xs font-medium">
                  <Gauge
                    className={`size-3.5 ${action === "rate_limit" ? "text-primary" : ""}`}
                  />
                  Rate Limit
                </span>
                <span className="text-muted-foreground text-[10px] leading-tight">
                  Allow up to N, then block
                </span>
              </button>
            </div>
            <p className="text-muted-foreground text-[11px]">
              Monitor and Approval actions coming soon.
            </p>

            {action === "rate_limit" && (
              <div className="space-y-2.5 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Input
                    id="rate-limit-max"
                    type="number"
                    min={1}
                    max={1000000}
                    value={rateLimit}
                    onChange={(e) =>
                      setRateLimit(parseInt(e.target.value) || 1)
                    }
                    className="h-8 w-24"
                  />
                  <span className="text-muted-foreground text-xs">
                    requests per
                  </span>
                  <Select
                    value={rateLimitWindow}
                    onValueChange={(v) =>
                      setRateLimitWindow(v as "minute" | "hour" | "day")
                    }
                  >
                    <SelectTrigger className="h-8 w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="minute">minute</SelectItem>
                      <SelectItem value="hour">hour</SelectItem>
                      <SelectItem value="day">day</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-muted-foreground text-[11px] leading-snug">
                  Each agent tracks its own counter. Excess requests return 429.
                </p>
              </div>
            )}
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
