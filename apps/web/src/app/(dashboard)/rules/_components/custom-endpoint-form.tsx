"use client";

import { useState, useEffect, useMemo } from "react";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { toast } from "sonner";
import {
  ShieldBan,
  ShieldCheck,
  Gauge,
  Hand,
  Check,
  Settings2,
} from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { cn } from "@onecli/ui/lib/utils";
import { validateDisplayName } from "@onecli/api/validations/display-name";
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
import { DialogFooter } from "@onecli/ui/components/dialog";
import type { PolicyMode } from "@onecli/api/validations/policy-rule";
import { updateRule as defaultUpdateRule } from "@/lib/actions/rules";
import { useQueryClient } from "@tanstack/react-query";
import { rules } from "@/lib/api";
import type { CreateRuleInput } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type { RuleCondition } from "@onecli/api/validations/policy-rule";
import { ConditionBuilder } from "@/lib/components/condition-builder";
import type { AgentOption, PolicyRuleItem, RuleActions } from "./types";

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
  },
  {
    id: "condition",
    label: "Condition",
  },
  {
    id: "action",
    label: "Action",
  },
] as const;

type Step = (typeof STEPS)[number]["id"];

interface CustomEndpointFormProps {
  onSaved?: () => void;
  onClose: () => void;
  agents: AgentOption[];
  rule?: PolicyRuleItem;
  showAgentField?: boolean;
  ruleActions?: RuleActions;
  policyMode?: PolicyMode;
}

export const CustomEndpointForm = ({
  onSaved,
  onClose,
  agents,
  rule,
  showAgentField = true,
  ruleActions,
  policyMode = "allow",
}: CustomEndpointFormProps) => {
  const isDenyMode = policyMode === "deny";
  const isEdit = !!rule;
  const invalidateCache = useInvalidateGatewayCache();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<Step>("endpoint");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [hostPattern, setHostPattern] = useState("");
  const [pathPattern, setPathPattern] = useState("");
  const [method, setMethod] = useState("");
  const [agentId, setAgentId] = useState("");
  const [action, setAction] = useState<
    "block" | "rate_limit" | "manual_approval" | "allow"
  >(isDenyMode ? "allow" : "block");
  const [rateLimit, setRateLimit] = useState(100);
  const [rateLimitWindow, setRateLimitWindow] = useState<
    "minute" | "hour" | "day"
  >("hour");
  const [enabled, setEnabled] = useState(true);
  const [conditions, setConditions] = useState<RuleCondition[]>([]);

  useEffect(() => {
    setStep("endpoint");
    setName(rule?.name ?? "");
    setNameTouched(false);
    setHostPattern(rule?.hostPattern ?? "");
    setPathPattern(rule?.pathPattern ?? "");
    setMethod(rule?.method ?? "");
    setAgentId(rule?.agentId ?? "");
    setAction(
      (rule?.action as "block" | "rate_limit" | "manual_approval" | "allow") ??
        (isDenyMode ? "allow" : "block"),
    );
    setRateLimit(rule?.rateLimit ?? 100);
    setRateLimitWindow(
      (rule?.rateLimitWindow as "minute" | "hour" | "day") ?? "hour",
    );
    setEnabled(rule?.enabled ?? true);
    setConditions((rule?.conditions as RuleCondition[]) ?? []);
  }, [rule, isDenyMode]);

  const nameError = useMemo(() => validateDisplayName(name), [name]);
  const showNameError = nameTouched && nameError !== null;
  const isNameValid = name.trim().length > 0 && nameError === null;
  const isEndpointValid = !!(isNameValid && hostPattern.trim());
  const isActionValid =
    action !== "rate_limit" || (rateLimit > 0 && rateLimitWindow);
  const isValid = isEndpointValid && isActionValid;

  const conditionsChanged = isEdit
    ? JSON.stringify(conditions) !==
      JSON.stringify(Array.isArray(rule?.conditions) ? rule.conditions : [])
    : false;

  const hasChanges = isEdit
    ? name.trim() !== rule.name ||
      hostPattern.trim() !== rule.hostPattern ||
      (pathPattern.trim() || null) !== rule.pathPattern ||
      (method || null) !== rule.method ||
      (agentId || null) !== rule.agentId ||
      action !== rule.action ||
      (action === "rate_limit" &&
        (rateLimit !== rule.rateLimit ||
          rateLimitWindow !== rule.rateLimitWindow)) ||
      conditionsChanged
    : true;

  const createRule =
    ruleActions?.createRule ??
    ((input: unknown) => rules.create(input as CreateRuleInput));
  const updateRule = ruleActions?.updateRule ?? defaultUpdateRule;

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
          conditions: conditions.length > 0 ? conditions : null,
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
          conditions: conditions.length > 0 ? conditions : undefined,
        });
        toast.success("Rule created");
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.rules.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
      onSaved?.();
      onClose();
      invalidateCache();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : isEdit
            ? "Failed to update rule"
            : "Failed to create rule",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* ── Stepper ──────────────────────────────────────────── */}
      <div className="flex items-center justify-center">
        {STEPS.map((s, i) => {
          const currentStepIndex = STEPS.findIndex((x) => x.id === step);
          const isCurrent = step === s.id;
          const isCompleted = i < currentStepIndex && isEndpointValid;
          const isClickable =
            s.id === "endpoint" ||
            (s.id === "condition" && isEndpointValid) ||
            (s.id === "action" && isEndpointValid);

          return (
            <div key={s.id} className="flex items-center">
              {i > 0 && (
                <div
                  className={cn(
                    "mx-3 h-px w-10",
                    isCompleted || isCurrent ? "bg-brand/30" : "bg-border",
                  )}
                />
              )}
              <button
                type="button"
                onClick={() => isClickable && setStep(s.id)}
                disabled={!isClickable}
                className="flex items-center gap-2.5 disabled:cursor-default"
              >
                <span
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full text-xs font-medium transition-colors",
                    isCurrent
                      ? "bg-brand text-brand-foreground"
                      : isCompleted
                        ? "bg-brand/15 text-brand"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {isCompleted ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span
                  className={cn(
                    "text-sm",
                    isCurrent
                      ? "text-foreground font-medium"
                      : isCompleted
                        ? "text-foreground"
                        : "text-muted-foreground",
                  )}
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
        <div className="space-y-4 pt-5">
          <div className="space-y-2">
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              placeholder="e.g. Limit Anthropic calls"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setNameTouched(true)}
              autoFocus
              className={cn(showNameError && "border-destructive")}
            />
            {showNameError && (
              <p className="text-destructive text-xs">{nameError}</p>
            )}
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

          <div
            className={cn(
              "grid gap-4",
              showAgentField ? "grid-cols-2" : "grid-cols-1",
            )}
          >
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

            {showAgentField && (
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
            )}
          </div>
        </div>
      )}

      {/* ── Step 2: Condition ──────────────────────────────────── */}
      {step === "condition" && (
        <div className="space-y-4 pt-5">
          <ConditionBuilder conditions={conditions} onChange={setConditions} />
        </div>
      )}

      {/* ── Step 3: Action ───────────────────────────────────── */}
      {step === "action" && (
        <div className="space-y-4 pt-5">
          <div className="grid grid-cols-3 gap-2">
            {isDenyMode ? (
              <button
                type="button"
                onClick={() => setAction("allow")}
                className={cn(
                  "flex flex-col gap-1.5 rounded-md border p-3.5 text-left transition-colors",
                  action === "allow"
                    ? "border-emerald-500 bg-emerald-500/5"
                    : "hover:bg-muted/50 hover:border-foreground/20",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <ShieldCheck
                    className={cn(
                      "size-4",
                      action === "allow" && "text-emerald-500",
                    )}
                  />
                  Allow
                </span>
                <span className="text-muted-foreground text-xs">
                  Permit the request through
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setAction("block")}
                className={cn(
                  "flex flex-col gap-1.5 rounded-md border p-3.5 text-left transition-colors",
                  action === "block"
                    ? "border-destructive bg-destructive/5"
                    : "hover:bg-muted/50 hover:border-foreground/20",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <ShieldBan
                    className={cn(
                      "size-4",
                      action === "block" && "text-destructive",
                    )}
                  />
                  Block
                </span>
                <span className="text-muted-foreground text-xs">
                  Deny the request entirely
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setAction("rate_limit")}
              className={cn(
                "flex flex-col gap-1.5 rounded-md border p-3.5 text-left transition-colors",
                action === "rate_limit"
                  ? "border-amber-500 bg-amber-500/5"
                  : "hover:bg-muted/50 hover:border-foreground/20",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Gauge
                  className={cn(
                    "size-4",
                    action === "rate_limit" && "text-amber-500",
                  )}
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
              className={cn(
                "flex flex-col gap-1.5 rounded-md border p-3.5 text-left transition-colors",
                action === "manual_approval"
                  ? "border-blue-500 bg-blue-500/5"
                  : "hover:bg-muted/50 hover:border-foreground/20",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Hand
                  className={cn(
                    "size-4",
                    action === "manual_approval" && "text-blue-500",
                  )}
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
                  onChange={(e) => setRateLimit(parseInt(e.target.value) || 1)}
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
      <DialogFooter className="pt-4">
        {step === "endpoint" && (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => setStep("condition")}
              disabled={!isEndpointValid}
            >
              Continue
            </Button>
          </>
        )}
        {step === "condition" && (
          <>
            <Button variant="ghost" onClick={() => setStep("endpoint")}>
              Back
            </Button>
            <Button onClick={() => setStep("action")}>Continue</Button>
          </>
        )}
        {step === "action" && (
          <>
            <Button variant="ghost" onClick={() => setStep("condition")}>
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
    </>
  );
};
