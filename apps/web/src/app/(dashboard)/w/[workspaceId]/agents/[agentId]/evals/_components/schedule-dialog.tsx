"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import {
  EVAL_REPORT_WHEN,
  type EvalReportBody,
  type EvalReportWhen,
} from "@onecli/api/validations/evals";
import {
  useDeleteEvalSchedule,
  useEvalReportChannels,
  useSaveEvalSchedule,
} from "@/hooks/use-evals";
import type { EvalSchedule } from "@/lib/api";
import { browserTimezone } from "@/lib/agents/schedule-timezone";
import {
  ScheduleWhenField,
  useScheduleWhen,
  whenFrom,
  type ScheduleWhen,
} from "../../schedules/_components/schedule-when-field";
import { ScheduleDialogFrame } from "../../schedules/_components/schedule-dialog-frame";
import { ScheduleAdvanced } from "../../schedules/_components/schedule-advanced";
import { ScheduleTimezoneField } from "../../schedules/_components/schedule-timezone-field";

/** The "Send results to" value: off, the person's own chat, or a channel
 * (`channel:<ref>`). */
type ReportTarget = "none" | "chat" | `channel:${string}`;

const targetOf = (current: EvalSchedule | null): ReportTarget => {
  const report = current?.report;
  if (!report) return "none";
  return report.to === "chat" ? "chat" : `channel:${report.channelRef}`;
};

const WHEN_LABEL: Record<EvalReportWhen, string> = {
  always: "Every run",
  changes: "When results change",
  failures: "When a test fails",
};

/**
 * Set, change or remove the agent's eval schedule: the same dialog as a
 * task schedule (`ScheduleDialogFrame`, the shared When and timezone),
 * plus where its results are sent. The server (croner) is the validator
 * and its message surfaces on refusal; runs are at most hourly. Keyed per
 * open by its parent, so state starts fresh.
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
  const [when, setWhen] = useState<ScheduleWhen>(() =>
    whenFrom(current?.schedule ?? null),
  );
  const [timezone, setTimezone] = useState(
    () => current?.timezone ?? browserTimezone(),
  );
  const read = useScheduleWhen(agentId, when, timezone);
  const [target, setTarget] = useState<ReportTarget>(() => targetOf(current));
  const [sendWhen, setSendWhen] = useState<EvalReportWhen>(
    current?.report?.when ?? "always",
  );
  const channels = useEvalReportChannels(agentId, open);
  // The saved channel stays pickable even if the list cannot load now.
  const savedChannel =
    current?.report?.to === "channel"
      ? { ref: current.report.channelRef, name: current.report.channelLabel }
      : null;
  const channelOptions = [
    ...(savedChannel && !channels.data?.some((c) => c.ref === savedChannel.ref)
      ? [savedChannel]
      : []),
    ...(channels.data ?? []),
  ];
  const busy = save.isPending || remove.isPending;

  const submit = () => {
    const schedule = read.expression;
    if (!schedule) return; // Save is disabled until the When is understood.
    const report: EvalReportBody | null =
      target === "none"
        ? null
        : target === "chat"
          ? { to: "chat", when: sendWhen }
          : {
              to: "channel",
              channelRef: target.slice("channel:".length),
              when: sendWhen,
            };
    save.mutate(
      { schedule, timezone: timezone.trim(), enabled: true, report },
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
    <ScheduleDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      title={current ? "Edit test schedule" : "Schedule tests"}
      description="Runs all test questions on a schedule, at most once an hour. Each run is compared with the last one."
      busy={busy}
      saving={save.isPending}
      canSave={read.expression !== null}
      saveLabel={current ? "Save" : "Schedule"}
      onSave={submit}
      {...(current && {
        deleteLabel: "Remove schedule",
        deleting: remove.isPending,
        onDelete: () =>
          remove.mutate(undefined, {
            onSuccess: () => {
              toast.success("Schedule removed");
              onOpenChange(false);
            },
            onError: (error) => toast.error(error.message),
          }),
      })}
    >
      <ScheduleWhenField
        id="eval-schedule-when"
        when={when}
        onChange={setWhen}
        hint={read.hint}
        hintIsError={read.hintIsError}
        expression={read.expression}
      />
      <ScheduleAdvanced summary={timezone.replace(/_/g, " ")}>
        <ScheduleTimezoneField
          id="eval-schedule-tz"
          value={timezone}
          onChange={setTimezone}
        />
      </ScheduleAdvanced>

      <div className="space-y-1.5">
        <Label htmlFor="eval-schedule-report">Send results to</Label>
        <div className="flex gap-2">
          <Select
            value={target}
            onValueChange={(value: ReportTarget) => setTarget(value)}
          >
            <SelectTrigger id="eval-schedule-report" className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nowhere</SelectItem>
              <SelectItem value="chat">My chat with the agent</SelectItem>
              {channelOptions.map((channel) => (
                <SelectItem key={channel.ref} value={`channel:${channel.ref}`}>
                  {channel.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {target !== "none" && (
            <Select
              value={sendWhen}
              onValueChange={(value: EvalReportWhen) => setSendWhen(value)}
            >
              <SelectTrigger aria-label="How often" className="w-44 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVAL_REPORT_WHEN.map((value) => (
                  <SelectItem key={value} value={value}>
                    {WHEN_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        {/* The bot joins a channel from Slack's side only, so this can't add
            one; it says how, and re-reads the list once it's done. */}
        <p className="text-muted-foreground text-xs">
          Channel not listed? Invite the agent to it in Slack, then{" "}
          <button
            type="button"
            className="text-foreground focus-visible:ring-ring/50 rounded-sm underline underline-offset-4 outline-none focus-visible:ring-2 disabled:opacity-50"
            disabled={channels.isFetching}
            onClick={() => void channels.refetch()}
          >
            {channels.isFetching ? "checking…" : "refresh"}
          </button>
          .
        </p>
      </div>
    </ScheduleDialogFrame>
  );
};
