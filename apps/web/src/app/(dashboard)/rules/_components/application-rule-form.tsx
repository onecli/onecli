"use client";

import { useState, useMemo } from "react";
import { CircleCheck, Hand, ShieldBan, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { cn } from "@onecli/ui/lib/utils";
import { Button } from "@onecli/ui/components/button";
import { Label } from "@onecli/ui/components/label";
import { DialogFooter } from "@onecli/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@onecli/ui/components/accordion";
import { Separator } from "@onecli/ui/components/separator";
import { getApps } from "@onecli/api/apps/registry";
import {
  getAppPermissionDefinition,
  allGroupTools,
  type AppPermissionLevel,
} from "@onecli/api/apps/app-permissions";
import type {
  RuleCondition,
  PolicyMode,
} from "@onecli/api/validations/policy-rule";
import { setAppPermissions as defaultSetAppPermissions } from "@/lib/actions/rules";
import { ConditionBuilder } from "@/lib/components/condition-builder";
import type { RuleActions } from "./types";
import { AppPickerGrid } from "./app-picker-grid";

type Scope = "all" | "read" | "write";

const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
  { value: "all", label: "All" },
  { value: "read", label: "Read-only" },
  { value: "write", label: "Write-only" },
];

const POLICY_OPTIONS: {
  value: AppPermissionLevel;
  label: string;
  description: string;
  icon: typeof CircleCheck;
}[] = [
  {
    value: "allow",
    label: "Always allow",
    description: "Requests go through without prompts",
    icon: CircleCheck,
  },
  {
    value: "manual_approval",
    label: "Require approval",
    description: "Agent must wait for human approval",
    icon: Hand,
  },
  {
    value: "block",
    label: "Block",
    description: "Deny the request entirely",
    icon: ShieldBan,
  },
];

type Step = "app" | "configure";

interface ApplicationRuleFormProps {
  onSaved?: () => void;
  onClose: () => void;
  ruleActions?: RuleActions;
  connectedProviders?: Map<string, string[]>;
  policyMode?: PolicyMode;
}

export const ApplicationRuleForm = ({
  onSaved,
  onClose,
  ruleActions,
  connectedProviders,
  policyMode = "allow",
}: ApplicationRuleFormProps) => {
  const isDenyMode = policyMode === "deny";
  const invalidateCache = useInvalidateGatewayCache();
  const [step, setStep] = useState<Step>("app");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("all");
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [policy, setPolicy] = useState<AppPermissionLevel>(
    isDenyMode ? "block" : "allow",
  );
  const [conditions, setConditions] = useState<RuleCondition[]>([]);
  const [saving, setSaving] = useState(false);

  const connectedProviderIds = useMemo(
    () => new Set(connectedProviders?.keys() ?? []),
    [connectedProviders],
  );

  const appsWithPermissions = useMemo(() => {
    const apps = getApps().filter(
      (app) => getAppPermissionDefinition(app.id) !== undefined,
    );
    return apps.sort((a, b) => {
      const aConnected = connectedProviderIds.has(a.id);
      const bConnected = connectedProviderIds.has(b.id);
      if (aConnected === bConnected) return a.name.localeCompare(b.name);
      return aConnected ? -1 : 1;
    });
  }, [connectedProviderIds]);

  const permDef = selectedProvider
    ? getAppPermissionDefinition(selectedProvider)
    : undefined;

  const toolsInScope = useMemo(() => {
    if (!permDef) return [];
    return permDef.groups
      .filter((g) => scope === "all" || g.category === scope)
      .flatMap((g) =>
        allGroupTools(g).map((t) => ({ ...t, category: g.category })),
      );
  }, [permDef, scope]);

  const groupedTools = useMemo(() => {
    if (!permDef) return [];
    return permDef.groups
      .filter((g) => scope === "all" || g.category === scope)
      .map((g) => ({
        category: g.category,
        label: g.category === "read" ? "Read" : "Write",
        tools: allGroupTools(g),
      }));
  }, [permDef, scope]);

  const handleSelectApp = (id: string) => {
    setSelectedProvider(id);
    setScope("all");
    setSelectedToolId(null);
    setPolicy("allow");
    setConditions([]);
  };

  const handleScopeChange = (newScope: Scope) => {
    setScope(newScope);
    setSelectedToolId(null);
  };

  const applyPermissions =
    ruleActions?.setAppPermissions ?? defaultSetAppPermissions;

  const handleSave = async () => {
    if (!selectedProvider || !permDef) return;
    setSaving(true);
    try {
      const changes = selectedToolId
        ? [{ toolId: selectedToolId, permission: policy }]
        : toolsInScope.map((t) => ({ toolId: t.id, permission: policy }));

      await applyPermissions(
        selectedProvider,
        changes,
        conditions.length > 0 ? conditions : undefined,
      );
      toast.success("Permissions updated");
      onSaved?.();
      onClose();
      invalidateCache();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update permissions",
      );
    } finally {
      setSaving(false);
    }
  };

  const isAppSelected = !!selectedProvider;

  return (
    <>
      {/* ── Step 1: Application ────────────────────────────────── */}
      {step === "app" && (
        <div>
          <AppPickerGrid
            apps={appsWithPermissions}
            selectedId={selectedProvider}
            onSelect={handleSelectApp}
          />
        </div>
      )}

      {/* ── Step 2: Configure ─────────────────────────────────── */}
      {step === "configure" && permDef && (
        <div className="space-y-3 pt-3">
          {/* ── Scope ──────────────────────────────────────────── */}
          <div className="space-y-2">
            <Label>Scope</Label>
            <div className="flex gap-1.5">
              {SCOPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleScopeChange(opt.value)}
                  className={cn(
                    "rounded-md border px-3.5 py-1.5 text-xs font-medium transition-colors",
                    scope === opt.value
                      ? "border-brand bg-brand/5 text-brand"
                      : "text-muted-foreground hover:bg-muted/50 hover:border-foreground/20",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <Separator />

          {/* ── Permission ─────────────────────────────────────── */}
          <div className="space-y-2">
            <Label>Permission</Label>
            <Select
              value={selectedToolId ?? "_all"}
              onValueChange={(v) => setSelectedToolId(v === "_all" ? null : v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">
                  {scope === "read"
                    ? "All read permissions"
                    : scope === "write"
                      ? "All write permissions"
                      : "All permissions"}
                </SelectItem>
                {groupedTools.map((group) => (
                  <SelectGroup key={group.category}>
                    <SelectLabel>{group.label}</SelectLabel>
                    {group.tools.map((tool) => (
                      <SelectItem key={tool.id} value={tool.id}>
                        {tool.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* ── Policy ─────────────────────────────────────────── */}
          <div className="space-y-2">
            <Label>Policy</Label>
            <div className="grid grid-cols-3 gap-2">
              {POLICY_OPTIONS.map((opt) => {
                const isSelected = policy === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPolicy(opt.value)}
                    className={cn(
                      "flex flex-col gap-1.5 rounded-md border p-3.5 text-left transition-colors",
                      isSelected
                        ? opt.value === "block"
                          ? "border-destructive bg-destructive/5"
                          : opt.value === "manual_approval"
                            ? "border-blue-500 bg-blue-500/5"
                            : "border-brand bg-brand/5"
                        : "hover:bg-muted/50 hover:border-foreground/20",
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <opt.icon
                        className={cn(
                          "size-4",
                          isSelected &&
                            (opt.value === "block"
                              ? "text-destructive"
                              : opt.value === "manual_approval"
                                ? "text-blue-500"
                                : "text-brand"),
                        )}
                      />
                      {opt.label}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {opt.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <Accordion type="single" collapsible className="border-none">
            <AccordionItem value="condition" className="border-t border-b-0">
              <AccordionTrigger className="py-3 hover:no-underline">
                <span className="text-muted-foreground flex items-center gap-2 text-xs font-normal">
                  <Settings2 className="size-3.5" />
                  Advanced settings
                </span>
              </AccordionTrigger>
              <AccordionContent className="pb-0">
                <ConditionBuilder
                  conditions={conditions}
                  onChange={setConditions}
                />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      )}

      {/* ── Footer ───────────────────────────────────────────── */}
      <DialogFooter className="pt-4">
        {step === "app" && (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => setStep("configure")}
              disabled={!isAppSelected}
            >
              Continue
            </Button>
          </>
        )}
        {step === "configure" && (
          <>
            <Button variant="ghost" onClick={() => setStep("app")}>
              Back
            </Button>
            <Button
              onClick={handleSave}
              loading={saving}
              disabled={!selectedProvider}
            >
              {saving ? "Saving..." : "Create Rule"}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
};
