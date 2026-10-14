"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { useDeleteEvalSchedule, useSaveEvalSchedule } from "@/hooks/use-evals";
import type { EvalSchedule } from "@/lib/api";
import {
  composeSchedule,
  draftFromSchedule,
  type ScheduleDraft,
  type SchedulePreset,
} from "@/lib/agents/eval-schedule";
import { browserTimezone } from "@/lib/agents/schedule-timezone";

/**
 * Set, change or remove the agent's eval schedule. Presets compose a cron
 * expression (daily, weekdays, weekly) and "Custom" takes one directly; the
 * server (croner) is the validator and its message surfaces on refusal.
 * The dialog is keyed per open by its parent, so state starts fresh.
 */
export const ScheduleDialog = ({
  agentId,
  open,
  onOpenChange,
  current,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: EvalSchedule | null;
}) => {
  const save = useSaveEvalSchedule(agentId);
  const remove = useDeleteEvalSchedule(agentId);
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    draftFromSchedule(current, browserTimezone()),
  );
  const update = (patch: Partial<ScheduleDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const busy = save.isPending || remove.isPending;

  const submit = () => {
    const schedule = composeSchedule(draft);
    if (!schedule) {
      toast.error(
        draft.preset === "custom"
          ? "Enter a cron expression"
          : "Enter a time like 09:00",
      );
      return;
    }
    save.mutate(
      { schedule, timezone: draft.timezone.trim(), enabled: true },
      {
        onSuccess: () => {
          toast.success(current ? "Schedule updated" : "Tests scheduled");
          onOpenChange(false);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule tests</DialogTitle>
          <DialogDescription>
            Run every test question automatically. Each run lands in Results,
            compared with the run before it, so a change shows up as
            &ldquo;Broke since last run&rdquo;.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <fieldset disabled={busy} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="eval-schedule-preset">Runs</Label>
                <Select
                  value={draft.preset}
                  onValueChange={(value: SchedulePreset) =>
                    update({ preset: value })
                  }
                >
                  <SelectTrigger id="eval-schedule-preset" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Every day</SelectItem>
                    <SelectItem value="weekdays">Weekdays</SelectItem>
                    <SelectItem value="weekly">Every Monday</SelectItem>
                    <SelectItem value="custom">Custom (cron)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                {draft.preset === "custom" ? (
                  <>
                    <Label htmlFor="eval-schedule-cron">Expression</Label>
                    <Input
                      id="eval-schedule-cron"
                      value={draft.custom}
                      onChange={(e) => update({ custom: e.target.value })}
                      placeholder="0 9 * * 1-5"
                      className="font-mono"
                    />
                  </>
                ) : (
                  <>
                    <Label htmlFor="eval-schedule-time">At</Label>
                    <Input
                      id="eval-schedule-time"
                      value={draft.time}
                      onChange={(e) => update({ time: e.target.value })}
                      placeholder="09:00"
                    />
                  </>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="eval-schedule-tz">Timezone</Label>
              <Input
                id="eval-schedule-tz"
                value={draft.timezone}
                onChange={(e) => update({ timezone: e.target.value })}
                placeholder="Asia/Jerusalem"
              />
            </div>
            <p className="text-muted-foreground text-xs">
              Runs as you, with the agent&apos;s own model key, at most once an
              hour. A run is skipped when one is already going or there are no
              test questions yet.
            </p>
          </fieldset>
        </DialogBody>
        <DialogFooter className="gap-2 sm:justify-between">
          {current ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    toast.success("Schedule removed");
                    onOpenChange(false);
                  },
                  onError: (error) => toast.error(error.message),
                })
              }
            >
              {remove.isPending ? "Removing…" : "Remove schedule"}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button loading={save.isPending} disabled={busy} onClick={submit}>
              {save.isPending ? "Saving…" : "Save schedule"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
