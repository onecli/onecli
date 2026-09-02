"use client";

import { useEffect, useState } from "react";
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
import { Textarea } from "@onecli/ui/components/textarea";
import { useCreateCron, useDeleteCron, useUpdateCron } from "@/hooks/use-crons";
import type { AgentCron } from "@/lib/api";

/**
 * Create/edit a schedule. No date libraries exist in this app, deliberately —
 * the presets compose a cron expression from two small inputs, and "Custom"
 * exposes the expression directly. The server (croner) is the validator; its
 * message surfaces verbatim on refusal.
 */

type Preset = "daily" | "hourly" | "once" | "custom";

/** The one-shot form: an ISO 8601 local datetime (croner reads it as a
 * fire-once pattern in the schedule's timezone; no offset by design — the
 * timezone field governs). */
const ONCE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

const presetOf = (schedule: string): Preset => {
  if (/^\d{1,2} \d{1,2} \* \* \*$/.test(schedule)) return "daily";
  if (/^\d{1,2} \* \* \* \*$/.test(schedule)) return "hourly";
  if (ONCE_SHAPE.test(schedule)) return "once";
  return "custom";
};

const timeOf = (schedule: string): string => {
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(schedule);
  if (!daily) return "09:00";
  return `${daily[2]!.padStart(2, "0")}:${daily[1]!.padStart(2, "0")}`;
};

const browserTimezone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export interface CronDialogProps {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = create. */
  editing: AgentCron | null;
}

export const CronDialog = ({
  agentId,
  open,
  onOpenChange,
  editing,
}: CronDialogProps) => {
  const create = useCreateCron(agentId);
  const update = useUpdateCron(agentId);
  const remove = useDeleteCron(agentId);

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [preset, setPreset] = useState<Preset>("daily");
  const [time, setTime] = useState("09:00");
  const [minute, setMinute] = useState("0");
  const [onceAt, setOnceAt] = useState("");
  const [custom, setCustom] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState(browserTimezone());

  // Re-seed the form whenever the dialog opens on a different target.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setPrompt(editing.prompt);
      setTimezone(editing.timezone);
      const detected = presetOf(editing.schedule);
      setPreset(detected);
      if (detected === "daily") setTime(timeOf(editing.schedule));
      if (detected === "hourly")
        setMinute(editing.schedule.split(" ")[0] ?? "0");
      if (detected === "once") setOnceAt(editing.schedule.slice(0, 16));
      if (detected === "custom") setCustom(editing.schedule);
    } else {
      setName("");
      setPrompt("");
      setPreset("daily");
      setTime("09:00");
      setMinute("0");
      setOnceAt("");
      setCustom("0 9 * * *");
      setTimezone(browserTimezone());
    }
  }, [open, editing]);

  const schedule = (): string | null => {
    if (preset === "custom") return custom.trim() || null;
    if (preset === "once") {
      // datetime-local yields "YYYY-MM-DDTHH:mm"; croner wants full seconds.
      const value = onceAt.trim();
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
      return `${value}:00`;
    }
    if (preset === "hourly") {
      const parsed = Number.parseInt(minute, 10);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 59) return null;
      return `${parsed} * * * *`;
    }
    const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    if (!match) return null;
    return `${Number.parseInt(match[2]!, 10)} ${Number.parseInt(match[1]!, 10)} * * *`;
  };

  const busy = create.isPending || update.isPending || remove.isPending;

  const submit = () => {
    const expression = schedule();
    if (!expression) {
      toast.error(
        preset === "daily"
          ? "Enter a time like 14:00"
          : preset === "once"
            ? "Pick a date and time"
            : "Enter a valid schedule",
      );
      return;
    }
    const input = {
      name: name.trim(),
      prompt: prompt.trim(),
      schedule: expression,
      timezone: timezone.trim(),
    };
    const handlers = {
      onSuccess: () => {
        toast.success(editing ? "Schedule updated" : "Schedule created");
        onOpenChange(false);
      },
      onError: (error: Error) => toast.error(String(error.message)),
    };
    if (editing) {
      update.mutate({ cronId: editing.id, input }, handlers);
    } else {
      create.mutate(input, handlers);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The FRAME is fixed and the fields scroll inside it: a schedule's
          prompt is a whole runbook in practice, and a dialog that grows with
          it would carry its own title and Save button off-screen — with
          nothing to scroll, since the dialog is positioned `fixed`. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit schedule" : "New schedule"}
          </DialogTitle>
          <DialogDescription>
            The agent runs this on schedule and reports back to the chat the
            schedule was created from.
          </DialogDescription>
        </DialogHeader>

        {/* `-m-1 p-1` buys the scroll box a 4px gutter: a focus ring is a
            box-shadow, which adds nothing to scrollable overflow, so a ring on
            an edge field would otherwise be shaved off by `overflow-y-auto`. */}
        <DialogBody className="-m-1 space-y-4 p-1">
          <div className="space-y-1.5">
            <Label htmlFor="cron-name">Name</Label>
            <Input
              id="cron-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Daily inbox check"
              maxLength={100}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cron-prompt">What should it do?</Label>
            <Textarea
              id="cron-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Check the support inbox and summarize anything urgent."
              rows={3}
              // `field-sizing-content` grows this field with what you type, so
              // it needs a ceiling of its own: uncapped, a long prompt claims
              // the whole body and pushes the schedule fields out of reach.
              className="max-h-[min(18rem,32dvh)]"
              maxLength={10_000}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Runs</Label>
              <Select
                value={preset}
                onValueChange={(value) => setPreset(value as Preset)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Every day</SelectItem>
                  <SelectItem value="hourly">Every hour</SelectItem>
                  <SelectItem value="once">Once, at a set time</SelectItem>
                  <SelectItem value="custom">Custom (cron)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              {preset === "daily" && (
                <>
                  <Label htmlFor="cron-time">At</Label>
                  <Input
                    id="cron-time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    placeholder="14:00"
                  />
                </>
              )}
              {preset === "hourly" && (
                <>
                  <Label htmlFor="cron-minute">At minute</Label>
                  <Input
                    id="cron-minute"
                    value={minute}
                    onChange={(event) => setMinute(event.target.value)}
                    placeholder="0"
                  />
                </>
              )}
              {preset === "once" && (
                <>
                  <Label htmlFor="cron-once">On</Label>
                  <Input
                    id="cron-once"
                    type="datetime-local"
                    value={onceAt}
                    onChange={(event) => setOnceAt(event.target.value)}
                  />
                </>
              )}
              {preset === "custom" && (
                <>
                  <Label htmlFor="cron-custom">Expression</Label>
                  <Input
                    id="cron-custom"
                    value={custom}
                    onChange={(event) => setCustom(event.target.value)}
                    placeholder="0 14 * * 1-5"
                    className="font-mono"
                  />
                </>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cron-tz">Timezone</Label>
            <Input
              id="cron-tz"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              placeholder="America/Los_Angeles"
            />
          </div>
        </DialogBody>

        <DialogFooter className="gap-2 sm:justify-between">
          {editing ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(editing.id, {
                  onSuccess: () => {
                    toast.success("Schedule deleted");
                    onOpenChange(false);
                  },
                  onError: (error) => toast.error(String(error.message)),
                })
              }
            >
              Delete
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
            <Button
              disabled={busy || !name.trim() || !prompt.trim()}
              loading={create.isPending || update.isPending}
              onClick={submit}
            >
              {editing ? "Save" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
