import {
  MAX_CRON_GATE_CHARS,
  MAX_CRON_GATE_DESCRIPTION_CHARS,
} from "@onecli/agent-protocol";
import type { CapabilityFragment } from "../home/renderer";
import type { PlatformToolDefinition } from "../platform-tools";

/**
 * The scheduled-tasks capability (step 7) — the first entry in the §3.7
 * registry. A capability owns BOTH halves of its arrival: the instruction
 * fragment the renderer collects (so the agent is taught the tools exactly
 * when it has them) and the MCP tool definitions the platform-tools server
 * advertises. The schemas here are the MODEL-facing contract; the control
 * plane's zod (validations/crons.ts) is the enforcement authority, and the
 * bounds are kept identical by eye — a drift fails loudly there, never
 * silently here.
 */

export const cronsFragment: CapabilityFragment = {
  id: "crons",
  title: "Scheduled tasks",
  body: `You can run work on a schedule with the schedule_task, update_task,
list_tasks, and cancel_task tools. To change a schedule, use update_task: it
keeps the schedule's history (cancel and recreate only to start over).

- A schedule needs an explicit IANA timezone (like "America/Los_Angeles") — clock
  times mean nothing without one. If the person did not say a timezone, ask,
  or use one they have clearly stated before.
- For RECURRING work the schedule is a standard 5-field cron expression
  (minute, hour, day-of-month, month, day-of-week). "Every day at 14:00" is
  "0 14 * * *".
- For something that should happen ONCE at a future time — "in 20 minutes",
  "tomorrow at 9" — pass an ISO 8601 local datetime as the schedule instead
  (like "2026-08-25T14:00:00", no offset; the timezone field governs). It
  fires once at that time, delivers its report, and completes. Prefer a
  one-shot schedule over sleeping in the foreground or polling the clock.
- Each schedule runs in its own separate conversation — not this one — and
  keeps its own memory between runs. Its report is delivered to the chat the
  schedule was created from.
- Name schedules descriptively; the name appears on every delivered report.
- Run conditions: when a person asks for a schedule that should only run when
  something happens ("only when there's a new deck", "only at minute 7"),
  YOU write the check. Put a small script in your workspace folder, run it
  once yourself to confirm it behaves, then pass its command as \`gate\` and
  the condition in plain words as \`gateDescription\` ("a new board deck
  appears in Dropbox": this is what the person sees). The check runs before
  each run with no model and no cost: no output (or {"wakeAgent": false} as
  its last line) and exit 0 means you are not run at all; any other output
  means you run with it;
  a nonzero exit fails the run, so end with \`exit 0\` when nothing changed.
  Write the prompt as what to do once the check fired; never repeat the
  condition in it. When the person wants the condition changed, update the
  script and gateDescription with update_task. Without a gate you run every
  time, and a run with nothing worth reporting answers exactly \`[no reply]\`
  so nothing is delivered.
- If these tools are missing right after your very first startup, they load a
  moment later — mention it and continue; from the next message on they are
  available immediately.`,
};

export const cronsTools: PlatformToolDefinition[] = [
  {
    name: "schedule_task",
    description:
      "Create a scheduled task on this agent — recurring (5-field cron expression) or one-shot (ISO 8601 datetime: runs once at that time, then completes). The task's prompt runs on the schedule in its own conversation, and each run's report is delivered to the chat where the schedule was created. Requires an explicit IANA timezone.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Short human-readable label for the schedule (shown on every report).",
          maxLength: 100,
        },
        prompt: {
          type: "string",
          description: "What to do on each run, written as an instruction.",
          maxLength: 10_000,
        },
        schedule: {
          type: "string",
          description:
            '5-field cron expression for recurring work ("0 14 * * *" = every day at 14:00), OR an ISO 8601 local datetime for a one-shot ("2026-08-25T14:00:00" = once at that time in the given timezone, then the schedule completes).',
          maxLength: 100,
        },
        timezone: {
          type: "string",
          description:
            'IANA timezone the schedule is read in, e.g. "America/Los_Angeles".',
          maxLength: 100,
        },
        gate: {
          type: "string",
          description:
            'Optional run condition: a shell command run before each run, in the workspace folder, with no model (free). Exit 0 with no output, or with {"wakeAgent": false} as its last line: the agent does not run. Any other output: the agent runs with that output. Nonzero exit: the run fails, so end with `exit 0` when nothing changed. Omit it to run the agent on every schedule.',
          maxLength: MAX_CRON_GATE_CHARS,
        },
        gateDescription: {
          type: "string",
          description:
            'The run condition in plain words, shown to the person instead of the command, e.g. "a new board deck appears in Dropbox". Required with a gate.',
          maxLength: MAX_CRON_GATE_DESCRIPTION_CHARS,
        },
      },
      required: ["name", "prompt", "schedule", "timezone"],
      additionalProperties: false,
    },
  },
  {
    name: "update_task",
    description:
      "Change an existing scheduled task in place (keeps its history): any of name, prompt, schedule, timezone, gate, gateDescription. A gate always needs its gateDescription; pass gate: null to remove the run condition (its description goes with it). Use list_tasks to find the id.",
    inputSchema: {
      type: "object",
      properties: {
        cronId: { type: "string", description: "The schedule's id." },
        name: { type: "string", maxLength: 100 },
        prompt: { type: "string", maxLength: 10_000 },
        schedule: { type: "string", maxLength: 100 },
        timezone: { type: "string", maxLength: 100 },
        gate: {
          type: ["string", "null"],
          description: "New run-condition command, or null to remove it.",
          maxLength: MAX_CRON_GATE_CHARS,
        },
        gateDescription: {
          type: ["string", "null"],
          description: "The run condition in plain words.",
          maxLength: MAX_CRON_GATE_DESCRIPTION_CHARS,
        },
      },
      required: ["cronId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_tasks",
    description:
      "List this agent's scheduled tasks: id, name, schedule, timezone, enabled state, and next fire time.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "cancel_task",
    description:
      "Cancel (delete) a scheduled task by its id — use list_tasks to find the id.",
    inputSchema: {
      type: "object",
      properties: {
        cronId: { type: "string", description: "The schedule's id." },
      },
      required: ["cronId"],
      additionalProperties: false,
    },
  },
];
