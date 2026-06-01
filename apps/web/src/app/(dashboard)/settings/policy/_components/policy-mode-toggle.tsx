"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Shield, ShieldOff } from "lucide-react";
import { Card, CardContent } from "@onecli/ui/components/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import { cn } from "@onecli/ui/lib/utils";
import type { PolicyMode } from "@onecli/api/validations/policy-rule";
import { updatePolicyMode } from "@/lib/actions/policy-mode";

const modes: {
  value: PolicyMode;
  label: string;
  description: string;
  icon: typeof Shield;
}[] = [
  {
    value: "allow",
    label: "Allow by default",
    description:
      "All traffic is allowed by default. Rules define what to block.",
    icon: ShieldOff,
  },
  {
    value: "deny",
    label: "Deny by default",
    description:
      "All traffic is blocked by default. Rules define what to allow.",
    icon: Shield,
  },
];

interface PolicyModeToggleProps {
  policyMode: PolicyMode;
}

export const PolicyModeToggle = ({ policyMode }: PolicyModeToggleProps) => {
  const [mode, setMode] = useState(policyMode);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const handleSelect = (newMode: PolicyMode) => {
    if (pending || newMode === mode) return;

    if (newMode === "deny") {
      setConfirmOpen(true);
      return;
    }

    doSave(newMode);
  };

  const doSave = (newMode: PolicyMode) => {
    setMode(newMode);
    startTransition(async () => {
      try {
        await updatePolicyMode(newMode);
        toast.success(
          newMode === "deny"
            ? "Default-deny mode enabled"
            : "Default-allow mode restored",
        );
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update policy mode",
        );
        setMode(policyMode);
      }
    });
  };

  return (
    <>
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="grid grid-cols-2 gap-3">
            {modes.map((opt) => {
              const isSelected = mode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleSelect(opt.value)}
                  disabled={pending}
                  className={cn(
                    "flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors",
                    isSelected
                      ? "border-brand bg-brand/5"
                      : "hover:bg-muted/50 hover:border-foreground/20",
                    pending && "cursor-not-allowed opacity-60",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <opt.icon
                      className={cn(
                        "size-4",
                        isSelected ? "text-brand" : "text-muted-foreground",
                      )}
                    />
                    {opt.label}
                  </span>
                  <span className="text-muted-foreground text-xs leading-relaxed">
                    {opt.description}
                  </span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable deny-by-default mode?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Switching to deny-by-default will{" "}
                  <strong>immediately block all agent traffic</strong> that
                  doesn&apos;t have an explicit allow rule.
                </p>
                <p>
                  This includes all API calls, app integrations, and secret
                  injections. You will need to create allow rules for every
                  endpoint your agents use.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => doSave("deny")}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              I understand, enable deny mode
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
