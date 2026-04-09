"use client";

import { useState, useEffect } from "react";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { toast } from "sonner";
import { ShieldBan, Gauge, Hand, Check, Settings2 } from "lucide-react";
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

const STEPS = [
  {
    id: "endpoint",
    label: "Endpoint",
    description: "Choose which requests this rule applies to.",
  },
  {
    id: "action",
    label: "Action",
    description: "Decide what happens when a request matches.",
  },
] as const;

type Step = (typeof STEPS)[number]["id"];

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
  const invalidateCache = useInvalidateGatewayCache();
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<Step>("endpoint");
  const [name, setName] = useState("");
  const [hostPattern, setHostPattern] = useState("");
  const [pathPattern, setPathPattern] = useState("");
  const [method, setMethod] = useState("");
  const [agentId, setAgentId] = useState("");
  const [action, setAction] = useState<
    "block" | "rate_limit" | "manual_approval"
  >("block");
  const [rateLimit, setRateLimit] = useState(100);
  const [rateLimitWindow, setRateLimitWindow] = useState<
    "minute" | "hour" | "day"
  >("hour");
  const [enabled, setEnabled] = useState(true);

  // Reset form when dialog opens or rule changes
  useEffect(() => {
    if (open) {
      setStep("endpoint");
      setName(rule?.name ?? "");
      setHostPattern(rule?.hostPattern ?? "");
      setPathPattern(rule?.pathPattern ?? "");
      setMethod(rule?.method ?? "");
      setAgentId(rule?.agentId ?? "");
      setAction(
        (rule?.action as "block" | "rate_limit" | "manual_approval") ?? "block",
      );
      setRateLimit(rule?.rateLimit ?? 100);
      setRateLimitWindow(
        (rule?.rateLimitWindow as "minute" | "hour" | "day") ?? "hour",
      );
      setEnabled(rule?.enabled ?? true);
    }
  }, [open, rule]);

  const isEndpointValid = !!(name.trim() && hostPattern.trim());
  const isActionValid =
    action !== "rate_limit" || (rateLimit > 0 && rateLimitWindow);
  const isValid = isEndpointValid && isActionValid;

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
      invalidateCache();
    } catch {
      toast.error(isEdit ? "Failed to update rule" : "Failed to create rule");
    } finally {
      setSaving(false);
    }
  };

  const handleClose = (value: boolean) => {
    onOpenChange(value);
  };

  const currentStep = STEPS.find((s) => s.id === step)!;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit rule" : "New rule"}</DialogTitle>
          <DialogDescription>{currentStep.description}</DialogDescription>
        </DialogHeader>

        {/* ── Stepper ──────────────────────────────────────────── */}
        <div className="flex items-center">
          {STEPS.map((s, i) => {
            const isCurrent = step === s.id;
            const isCompleted =
              s.id === "endpoint" && step === "action" && isEndpointValid;
            const isClickable =
              s.id === "endpoint" || (s.id === "action" && isEndpointValid);

            return (
              <div key={s.id} className="flex items-center">
                {i > 0 && (
                  <div
                    className={`mx-3 h-px w-10 ${isCompleted || isCurrent ? "bg-brand/30" : "bg-border"}`}
                  />
                )}
                <button
                  type="button"
                  onClick={() => isClickable && setStep(s.id)}
                  disabled={!isClickable}
                  className="flex items-center gap-2.5 disabled:cursor-default"
                >
                  <span
                    className={`flex size-7 items-center justify-center rounded-full text-xs font-medium transition-colors ${
                      isCurrent
                        ? "bg-brand text-brand-foreground"
                        : isCompleted
                          ? "bg-brand/15 text-brand"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isCompleted ? <Check className="size-3.5" /> : i + 1}
                  </span>
                  <span
                    className={`text-sm ${
                      isCurrent
                        ? "text-foreground font-medium"
                        : isCompleted
                          ? "text-foreground"
                          : "text-muted-foreground"
                    }`}
                  >
                    {s.label}
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        {/* ── Step 1: Endpoint ─────────────────────────────────── */}
        {step === "endpoint" && (
          <div className="space-y-4 pt-1">
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
                  Use <code className="text-xs">*.example.com</code> for
                  wildcard subdomains.
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
          </div>
        )}

        {/* ── Step 2: Action ───────────────────────────────────── */}
        {step === "action" && (
          <div className="space-y-4 pt-1">
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setAction("block")}
                className={`flex flex-col gap-1.5 rounded-md border p-3.5 text-left transition-colors ${
                  action === "block"
                    ? "border-brand bg-brand/5"
                    : "hover:bg-muted/50"
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <ShieldBan
                    className={`size-4 ${action === "block" ? "text-brand" : ""}`}
                  />
                  Block
                </span>
                <span className="text-muted-foreground text-xs">
                  Deny the request entirely
                </span>
              </button>
              <button
                type="button"
                onClick={() => setAction("rate_limit")}
                className={`flex flex-col gap-1.5 rounded-md border p-3.5 text-left transition-colors ${
                  action === "rate_limit"
                    ? "border-brand bg-brand/5"
                    : "hover:bg-muted/50"
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Gauge
                    className={`size-4 ${action === "rate_limit" ? "text-brand" : ""}`}
                  />
                  Rate Limit
                </span>
                <span className="text-muted-foreground text-xs">
                  Allow up to N requests, then block
                </span>
              </button>
              <button
                type="button"
                onClick={() => setAction("manual_approval")}
                className={`flex flex-col gap-1.5 rounded-md border p-3.5 text-left transition-colors ${
                  action === "manual_approval"
                    ? "border-brand bg-brand/5"
                    : "hover:bg-muted/50"
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Hand
                    className={`size-4 ${action === "manual_approval" ? "text-brand" : ""}`}
                  />
                  Manual Approval
                </span>
                <span className="text-muted-foreground text-xs">
                  Require human approval before proceeding
                </span>
              </button>
            </div>

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
        )}

        {/* ── Footer ───────────────────────────────────────────── */}
        <DialogFooter>
          {step === "endpoint" ? (
            <>
              <Button variant="ghost" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => setStep("action")}
                disabled={!isEndpointValid}
              >
                Continue
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setStep("endpoint")}>
                Back
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
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
