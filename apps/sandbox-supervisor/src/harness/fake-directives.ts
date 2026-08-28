import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@onecli/agent-protocol";

/**
 * The fake adapter's scripted-turn seam (step 13): a turn message carrying a
 * `@fake:v1 {json}` line runs the JSON's steps instead of the static script,
 * which is what lets a BLACK-BOX caller (the hosted-e2e suite, a curl into a
 * live stack) drive turn shape from outside the process — long runs for
 * steering runway, an outbound HTTP call that transits the gateway, a
 * platform-tool invocation, a scripted failure.
 *
 * The directive line is searched anywhere in the message (first match wins),
 * not only at position zero: the supervisor prepends the delivery-only
 * context frame to the model-facing prompt (supervisor.ts, step 8), so the
 * caller's first line is not guaranteed to be the prompt's first line. This
 * is a test adapter — only agents created with `harness: "fake"` ever parse
 * it, and a non-matching message takes the legacy script path untouched.
 *
 * Every step maps onto behaviors the conformance suite already pins (event
 * order, terminals, the per-event gap where steers inject); the executor only
 * SEQUENCES them, so a directive turn cannot express anything the fake could
 * not already do in-process.
 */

const MARKER = "@fake:v1";

/** Bounds, all deliberately tight: this is a test vocabulary, not a runtime. */
const MAX_STEPS = 64;
const MAX_SLEEP_MS = 30_000;
const SLEEP_CHUNK_MS = 250;
const MAX_HTTP_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const TOOL_CALL_TIMEOUT_MS = 25_000;
/** Excerpt cap for http/tool echoes — enough to assert on, never a dump. */
const EXCERPT_CHARS = 300;

export type FakeStep =
  | { op: "text"; text: string }
  | { op: "sleep"; ms: number }
  | { op: "state" }
  | {
      op: "http";
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
    }
  | { op: "tool"; name: string; args?: unknown }
  | { op: "error"; message: string }
  | { op: "failNextStart"; reason?: string };

export interface FakeDirective {
  steps: FakeStep[];
}

export type ParsedDirective =
  | { directive: FakeDirective }
  | { error: string }
  | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseStep = (
  raw: unknown,
  index: number,
): FakeStep | { error: string } => {
  if (!isRecord(raw)) return { error: `step ${index} is not an object` };
  switch (raw.op) {
    case "text":
      if (typeof raw.text !== "string")
        return { error: `step ${index}: "text" needs a string text` };
      return { op: "text", text: raw.text };
    case "sleep": {
      if (typeof raw.ms !== "number" || !Number.isFinite(raw.ms))
        return { error: `step ${index}: "sleep" needs a numeric ms` };
      return { op: "sleep", ms: Math.min(Math.max(raw.ms, 0), MAX_SLEEP_MS) };
    }
    case "state":
      return { op: "state" };
    case "http": {
      if (typeof raw.url !== "string")
        return { error: `step ${index}: "http" needs a string url` };
      const headers = isRecord(raw.headers)
        ? Object.fromEntries(
            Object.entries(raw.headers).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          )
        : undefined;
      const timeoutMs =
        typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
          ? Math.min(Math.max(raw.timeoutMs, 1), MAX_HTTP_TIMEOUT_MS)
          : undefined;
      return {
        op: "http",
        url: raw.url,
        ...(typeof raw.method === "string" && { method: raw.method }),
        ...(headers && { headers }),
        ...(typeof raw.body === "string" && { body: raw.body }),
        ...(timeoutMs !== undefined && { timeoutMs }),
      };
    }
    case "tool":
      if (typeof raw.name !== "string")
        return { error: `step ${index}: "tool" needs a string name` };
      return { op: "tool", name: raw.name, args: raw.args };
    case "error":
      if (typeof raw.message !== "string")
        return { error: `step ${index}: "error" needs a string message` };
      return { op: "error", message: raw.message };
    case "failNextStart":
      return {
        op: "failNextStart",
        ...(typeof raw.reason === "string" && { reason: raw.reason }),
      };
    default:
      return { error: `step ${index}: unknown op ${JSON.stringify(raw.op)}` };
  }
};

/**
 * Find and parse a directive in a turn message. `null` = no directive (take
 * the legacy script path); `{error}` = a directive line that does not parse —
 * surfaced as a readable event, never a hang, because a silently-ignored
 * typo'd directive would make an e2e assert on the wrong behavior.
 */
export const parseFakeDirective = (message: string): ParsedDirective => {
  const line = message
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(MARKER));
  if (line === undefined) return null;

  const payload = line.slice(MARKER.length).trim();
  if (payload === "") return { error: "missing JSON payload" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    return { error: `invalid JSON: ${String(error).slice(0, 120)}` };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.steps))
    return { error: 'expected {"steps": [...]}' };
  if (parsed.steps.length > MAX_STEPS)
    return { error: `too many steps (max ${MAX_STEPS})` };

  const steps: FakeStep[] = [];
  for (const [index, raw] of parsed.steps.entries()) {
    const step = parseStep(raw, index);
    if ("error" in step) return { error: step.error };
    steps.push(step);
  }
  return { directive: { steps } };
};

/** What the executor needs from the session/harness it runs inside. */
export interface DirectiveContext {
  sessionRef: string;
  turnsRun: () => number;
  /** The platform-tools socket THIS process serves (test seam overridable). */
  toolsSocketPath: () => string;
  /** Arms the harness's one-shot launch failure (the dead-harness leg). */
  armLaunchFailure: (reason?: string) => void;
}

const excerpt = (value: string): string => value.slice(0, EXCERPT_CHARS);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One JSONL request/response over the platform-tools Unix socket — the same
 * wire the MCP bridge speaks (platform-tools.ts documents the socket is not a
 * trust boundary: the agent shares the container and could dial it directly,
 * which is exactly what this op does on the agent's behalf).
 */
const callPlatformTool = (
  socketPath: string,
  tool: string,
  args: unknown,
): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
  new Promise((resolve) => {
    const id = randomUUID();
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (outcome: {
      ok: boolean;
      result?: unknown;
      error?: string;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "platform tool call timed out" }),
      TOOL_CALL_TIMEOUT_MS,
    );
    socket.on("error", (error) => finish({ ok: false, error: String(error) }));
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ id, op: "call", tool, args: args ?? {} })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as {
          ok?: unknown;
          result?: unknown;
          error?: unknown;
        };
        finish({
          ok: reply.ok === true,
          result: reply.result,
          ...(typeof reply.error === "string" && { error: reply.error }),
        });
      } catch {
        finish({ ok: false, error: "malformed platform tool reply" });
      }
    });
  });

/**
 * Execute a directive as an event stream. The caller (FakeSession.runTurn)
 * owns the per-event gap, abort, liveness, and steer injection — this
 * generator only produces events, so directive turns inherit every law the
 * conformance suite pins on the script path.
 */
export async function* runDirective(
  directive: FakeDirective,
  ctx: DirectiveContext,
): AsyncGenerator<AgentEvent> {
  for (const step of directive.steps) {
    switch (step.op) {
      case "text":
        yield { type: "text.delta", text: step.text };
        break;
      case "sleep": {
        // Chunked so a dispose/process exit is never held behind one long
        // timer; abort semantics are unchanged (checked at event gaps).
        let remaining = step.ms;
        while (remaining > 0) {
          const chunk = Math.min(remaining, SLEEP_CHUNK_MS);
          await sleep(chunk);
          remaining -= chunk;
        }
        break;
      }
      case "state":
        yield {
          type: "text.delta",
          text: `[state sessionRef=${ctx.sessionRef} turnsRun=${ctx.turnsRun()}]`,
        };
        break;
      case "http": {
        try {
          const response = await fetch(step.url, {
            method: step.method ?? "GET",
            ...(step.headers && { headers: step.headers }),
            ...(step.body !== undefined && { body: step.body }),
            signal: AbortSignal.timeout(
              step.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
            ),
          });
          const body = await response.text();
          yield {
            type: "text.delta",
            text: `[http ${response.status}] ${excerpt(body)}`,
          };
        } catch (error) {
          yield {
            type: "text.delta",
            text: `[http error] ${excerpt(String(error))}`,
          };
        }
        break;
      }
      case "tool": {
        const outcome = await callPlatformTool(
          ctx.toolsSocketPath(),
          step.name,
          step.args,
        );
        yield {
          type: "text.delta",
          text: outcome.ok
            ? `[tool ${step.name} ok] ${excerpt(JSON.stringify(outcome.result ?? null))}`
            : `[tool ${step.name} error] ${excerpt(outcome.error ?? "failed")}`,
        };
        break;
      }
      case "error":
        yield { type: "error", message: step.message };
        return;
      case "failNextStart":
        ctx.armLaunchFailure(step.reason);
        yield { type: "text.delta", text: "[fake: armed failNextStart]" };
        break;
      default: {
        const unreachable: never = step;
        throw new Error(`unhandled step: ${JSON.stringify(unreachable)}`);
      }
    }
  }
}
