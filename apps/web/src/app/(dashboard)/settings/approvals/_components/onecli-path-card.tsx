"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, ShieldAlert } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Switch } from "@onecli/ui/components/switch";
import { Input } from "@onecli/ui/components/input";
import { Button } from "@onecli/ui/components/button";
import {
  saveApprovalPath,
  setApprovalPathEnabled,
} from "@/lib/actions/approval-paths";
import { FieldLabel } from "./field-label";

interface OneCliPathCardProps {
  enabled: boolean;
  settings: Record<string, string>;
}

export const OneCliPathCard = ({
  enabled: initialEnabled,
  settings,
}: OneCliPathCardProps) => {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [timeoutSecs, setTimeoutSecs] = useState(
    settings.timeoutSeconds ?? "120",
  );
  const [togglePending, startToggle] = useTransition();
  const [savePending, startSave] = useTransition();

  const handleToggle = (next: boolean) => {
    setEnabled(next);
    startToggle(async () => {
      try {
        await setApprovalPathEnabled("onecli", next);
        toast.success(
          next ? "OneCLI approvals enabled" : "OneCLI approvals disabled",
        );
      } catch (err) {
        setEnabled(!next);
        toast.error(err instanceof Error ? err.message : "Failed to update");
      }
    });
  };

  const handleSave = () => {
    startSave(async () => {
      try {
        await saveApprovalPath("onecli", { timeoutSeconds: timeoutSecs });
        setEnabled(true);
        toast.success("Saved");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save");
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle className="select-text">OneCLI SDK</CardTitle>
            <CardDescription className="select-text">
              Decisions are delivered to the OneCLI SDK / dashboard via
              long-poll. This is the built-in path.
            </CardDescription>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={togglePending}
            aria-label="Enable OneCLI approval path"
          />
        </div>
      </CardHeader>

      {/* Fields collapse when disabled — keeps the list short as channels grow. */}
      {enabled && (
        <CardContent className="space-y-4">
          <div className="border-amber-500/30 bg-amber-500/5 text-foreground flex items-start gap-2 rounded-md border p-3 text-xs">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <p className="select-text">
              Least-trusted path: the approver runs on the same host the agent
              controls, so a fully-compromised agent could approve its own
              requests. Prefer an out-of-band channel (e.g. ntfy) for sensitive
              actions.
            </p>
          </div>

          <div className="space-y-2">
            <FieldLabel
              htmlFor="onecli-timeout"
              label="Hold Timeout (seconds)"
              short="How long a request is held awaiting a decision."
              detail={
                "How many seconds a request is held awaiting an approve/deny decision before it auto-denies.\n\nThe held request uses the LONGEST timeout among all enabled channels, so raising another channel's timeout (e.g. ntfy) also extends this one."
              }
            />
            <div className="flex items-center gap-2">
              <Input
                id="onecli-timeout"
                type="number"
                min={5}
                className="max-w-40"
                value={timeoutSecs}
                onChange={(e) => setTimeoutSecs(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleSave}
                disabled={savePending}
              >
                {savePending && <Loader2 className="size-4 animate-spin" />}
                {savePending ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
};
