/**
 * Typed builders for the fake harness's `@fake:v1` turn directive
 * (apps/sandbox-supervisor/src/harness/fake-directives.ts) — tests compose
 * plans instead of hand-writing JSON, and a syntax change breaks
 * `check-types` here rather than turning into runtime `[fake: bad
 * directive]` noise across the suite.
 */

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

/** The directive line, with optional trailing prose (ignored by the fake). */
export const fakeDirective = (steps: FakeStep[], prose = ""): string =>
  `@fake:v1 ${JSON.stringify({ steps })}${prose === "" ? "" : `\n${prose}`}`;

export const text = (value: string): FakeStep => ({ op: "text", text: value });
export const sleep = (ms: number): FakeStep => ({ op: "sleep", ms });
export const state = (): FakeStep => ({ op: "state" });
export const http = (
  url: string,
  opts: Omit<Extract<FakeStep, { op: "http" }>, "op" | "url"> = {},
): FakeStep => ({ op: "http", url, ...opts });
export const tool = (name: string, args?: unknown): FakeStep => ({
  op: "tool",
  name,
  ...(args !== undefined && { args }),
});
export const scriptedError = (message: string): FakeStep => ({
  op: "error",
  message,
});
export const failNextStart = (reason?: string): FakeStep => ({
  op: "failNextStart",
  ...(reason !== undefined && { reason }),
});
