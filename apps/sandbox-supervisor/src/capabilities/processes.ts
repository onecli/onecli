import { z } from "zod";
import {
  MAX_PROCESS_COMMAND_CHARS,
  MAX_PROCESS_NAME_CHARS,
  MAX_WATCH_PATTERN_CHARS,
  MAX_WATCH_PROMPT_CHARS,
} from "@onecli/agent-protocol";
import type { CapabilityFragment } from "../home/renderer";
import type { PlatformToolDefinition } from "../platform-tools";
import {
  WATCH_EXPIRES_DEFAULT_SECONDS,
  WATCH_EXPIRES_MAX_SECONDS,
  WATCH_EXPIRES_MIN_SECONDS,
  WATCH_SILENCE_MAX_SECONDS,
  WATCH_SILENCE_MIN_SECONDS,
  type ProcessManager,
} from "../processes/manager";

/**
 * The background-processes capability (step 10) — the registry's first
 * LOCALLY-EXECUTED tool set: the definitions close over the process manager
 * and answer in this process, because only the supervisor can spawn into the
 * container. That INVERTS the crons/memory drift rule — there is no
 * control-plane zod behind these, so the schemas here plus the parses below
 * ARE the enforcement authority, not a mirror kept identical by eye.
 */

export const processesFragment: CapabilityFragment = {
  id: "processes",
  title: "Background processes",
  body: `You can run long work in the background. Your machine SLEEPS when
your conversations go idle — but the platform tracks background tasks
however you start them, keeps the machine awake while they run, and wakes
you through watches.

- process_start runs a shell command in the background from your home.
  It keeps running after your turn ends.
- process_status lists ALL tracked background tasks — including ones you
  started other ways — with their recent output.
- process_watch wakes you ONCE when something happens to any listed task:
  "exit" (it ended), "pattern" (a literal text appears in its output), or
  "silence" (no output for N seconds). Your watch prompt runs automatically
  and its report reaches this chat. Watches expire
  (default 4 hours), and every watch also fires if the process ends first,
  whatever its kind — so say in the prompt what to do in each case. This is
  THE way to be woken about background work; a wake requested through your
  own tooling is honored the same way, as a watch.
- process_stop stops a process_start task; tasks started other ways are
  stopped the way they were started.
- If the machine restarts, background tasks die and their watches fire with
  "lost" so you can restart the work.
- Nothing runs between your turns. A promise to "report back" is only real
  after you arm the watch (or schedule) that will wake you. To follow
  something outside this machine (a CI run, a deploy), process_start a
  poller for it and watch that.`,
};

const startSchema = z
  .object({
    command: z.string().min(1).max(MAX_PROCESS_COMMAND_CHARS),
    name: z.string().min(1).max(MAX_PROCESS_NAME_CHARS).optional(),
  })
  .strict();

const statusSchema = z
  .object({
    processId: z.string().min(1).max(100).optional(),
    // Accepted and ignored: harness-native tools take this key to lift
    // output truncation, and models reflexively pass it here too (observed
    // live). The recent tail is already returned in full, so honoring the
    // key is a no-op — but rejecting it turns a harmless habit into a
    // failed call and a red row in the chat.
    accept_large_output: z.boolean().optional(),
  })
  .strict();

const stopSchema = z.object({ processId: z.string().min(1).max(100) }).strict();

const watchSchema = z
  .object({
    processId: z.string().min(1).max(100),
    kind: z.enum(["exit", "pattern", "silence"]),
    pattern: z.string().min(1).max(MAX_WATCH_PATTERN_CHARS).optional(),
    silenceSeconds: z
      .number()
      .int()
      .min(WATCH_SILENCE_MIN_SECONDS)
      .max(WATCH_SILENCE_MAX_SECONDS)
      .optional(),
    prompt: z.string().min(1).max(MAX_WATCH_PROMPT_CHARS),
    expiresInSeconds: z
      .number()
      .int()
      .min(WATCH_EXPIRES_MIN_SECONDS)
      .max(WATCH_EXPIRES_MAX_SECONDS)
      .optional(),
  })
  .strict()
  .refine(
    (args) => (args.kind === "pattern") === (args.pattern !== undefined),
    {
      message: 'kind "pattern" needs `pattern`; other kinds must not carry it',
    },
  )
  .refine(
    (args) => (args.kind === "silence") === (args.silenceSeconds !== undefined),
    {
      message:
        'kind "silence" needs `silenceSeconds`; other kinds must not carry it',
    },
  );

const parseFailure = (
  issue: string | undefined,
): { ok: false; error: string } => ({
  ok: false,
  error: issue ?? "Invalid input",
});

export const createProcessTools = (
  manager: ProcessManager,
): PlatformToolDefinition[] => [
  {
    name: "process_start",
    description:
      "Run a shell command in the background on this machine. It keeps running after your turn ends and its output is captured. Arm a process_watch if you want to be woken when something happens — the machine may otherwise sleep once conversations go idle.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The shell command to run (executed with /bin/sh -c from the home).",
          maxLength: MAX_PROCESS_COMMAND_CHARS,
        },
        name: {
          type: "string",
          description: "Short human-readable label, shown on reports.",
          maxLength: MAX_PROCESS_NAME_CHARS,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const parsed = startSchema.safeParse(args);
      if (!parsed.success) return parseFailure(parsed.error.issues[0]?.message);
      return manager.start(parsed.data, context);
    },
  },
  {
    name: "process_status",
    description:
      "List this machine's background processes, or — with processId — one process's full status and recent output.",
    inputSchema: {
      type: "object",
      properties: {
        processId: {
          type: "string",
          description: "A process id from process_start or the list.",
        },
        accept_large_output: {
          type: "boolean",
          description:
            "Accepted for compatibility; output is already returned in full.",
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const parsed = statusSchema.safeParse(args ?? {});
      if (!parsed.success) return parseFailure(parsed.error.issues[0]?.message);
      return manager.status({
        ...(parsed.data.processId !== undefined && {
          processId: parsed.data.processId,
        }),
      });
    },
  },
  {
    name: "process_stop",
    description:
      "Stop a background process (SIGTERM to its whole process group, SIGKILL after a few seconds).",
    inputSchema: {
      type: "object",
      properties: {
        processId: { type: "string", description: "The process to stop." },
      },
      required: ["processId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const parsed = stopSchema.safeParse(args);
      if (!parsed.success) return parseFailure(parsed.error.issues[0]?.message);
      return manager.stop(parsed.data);
    },
  },
  {
    name: "process_watch",
    description: `Wake yourself ONCE when something happens to a background process: kind "exit" (it ends), "pattern" (a literal text appears in its output — needs \`pattern\`), or "silence" (no output for N seconds — needs \`silenceSeconds\`). Your prompt then runs automatically and its report reaches the chat where you armed the watch. Every watch also fires if the process ends first, whatever its kind. Expires after expiresInSeconds (default ${WATCH_EXPIRES_DEFAULT_SECONDS}).`,
    inputSchema: {
      type: "object",
      properties: {
        processId: { type: "string", description: "The process to watch." },
        kind: { type: "string", enum: ["exit", "pattern", "silence"] },
        pattern: {
          type: "string",
          description:
            'Literal text to look for in the output (kind "pattern" only — not a regex).',
          maxLength: MAX_WATCH_PATTERN_CHARS,
        },
        silenceSeconds: {
          type: "integer",
          description: `Seconds of no output that count as silence (kind "silence" only; ${WATCH_SILENCE_MIN_SECONDS}-${WATCH_SILENCE_MAX_SECONDS}).`,
          minimum: WATCH_SILENCE_MIN_SECONDS,
          maximum: WATCH_SILENCE_MAX_SECONDS,
        },
        prompt: {
          type: "string",
          description:
            "What to do when it fires, written as an instruction to your future self.",
          maxLength: MAX_WATCH_PROMPT_CHARS,
        },
        expiresInSeconds: {
          type: "integer",
          description: `Give up after this many seconds (${WATCH_EXPIRES_MIN_SECONDS}-${WATCH_EXPIRES_MAX_SECONDS}, default ${WATCH_EXPIRES_DEFAULT_SECONDS}).`,
          minimum: WATCH_EXPIRES_MIN_SECONDS,
          maximum: WATCH_EXPIRES_MAX_SECONDS,
        },
      },
      required: ["processId", "kind", "prompt"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const parsed = watchSchema.safeParse(args);
      if (!parsed.success) return parseFailure(parsed.error.issues[0]?.message);
      return manager.watch(parsed.data, context);
    },
  },
];
