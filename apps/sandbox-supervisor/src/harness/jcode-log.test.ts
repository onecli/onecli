import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileFollower } from "../logs/file-follower";
import {
  createEntryAssembler,
  forwardJcodeStderr,
  isInfoNoise,
  MAX_ENTRY_CHARS,
  startJcodeLogForwarder,
  type JcodeLogEntry,
} from "./jcode-log";

/**
 * The jcode log forwarder. Fixture lines are copied from a real v0.81.1
 * daemon log (the pinned agent image, 2026-10-01): the format contract
 * this module parses.
 */

interface Emitted {
  level: string;
  message: string;
  source?: string;
  suppressed?: number;
  jcodeTime?: string;
  [key: string]: unknown;
}

let stderr: string[] = [];
let followers: FileFollower[] = [];

beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  for (const follower of followers) follower.stop();
  followers = [];
  vi.restoreAllMocks();
});

const emitted = (): Emitted[] =>
  stderr.map((line) => JSON.parse(line) as Emitted);

const home = () => {
  const jcodeHome = mkdtempSync(join(tmpdir(), "jcode-home-"));
  mkdirSync(join(jcodeHome, "logs"), { recursive: true });
  const file = join(jcodeHome, "logs", "jcode-2026-10-01.log");
  writeFileSync(file, "[2026-10-01 13:00:00.000] [ERROR] a previous boot\n");
  return { jcodeHome, file };
};

const start = (
  jcodeHome: string,
  opts?: { burst?: number; now?: () => number },
) => {
  const follower = startJcodeLogForwarder({
    jcodeHome,
    pollIntervalMs: 60_000,
    ...opts,
  });
  followers.push(follower);
  return follower;
};

describe("jcode log entry assembler", () => {
  const assemble = (lines: string[]): JcodeLogEntry[] => {
    const out: JcodeLogEntry[] = [];
    const assembler = createEntryAssembler((entry) => out.push(entry));
    for (const line of lines) assembler.push(line);
    assembler.flush();
    return out;
  };

  it("maps the level vocabulary: ERROR/WARN keep meaning, everything else is info", () => {
    const entries = assemble([
      "[2026-10-01 13:54:13.349] [ERROR] Usage fetch error: Failed to load Claude credentials",
      "[2026-10-01 13:54:13.371] [WARN] Claude OAuth is unusable in automatic credential mode",
      "[2026-10-01 13:54:13.268] [AUTH] AUTH event=runtime_activation_clear_initial_provider",
      "[2026-10-01 13:54:13.490] [INFO] [srv:grove] Server 🌳 grove starting (v0.81.1 (cae6d2a57))",
    ]);
    expect(entries.map((e) => e.level)).toEqual([
      "error",
      "warn",
      "info",
      "info",
    ]);
    expect(entries[0]?.at).toBe("2026-10-01 13:54:13.349");
  });

  it("joins continuation lines (a Caused-by chain) into their header's entry", () => {
    const entries = assemble([
      "[2026-10-01 13:52:54.500] [ERROR] restrict API socket /workspace/.jcode-home/run/jcode-api.sock",
      "",
      "Caused by:",
      "    Invalid argument (os error 22)",
      "[2026-10-01 13:52:54.502] [INFO] Registered as 🌵 desert in server registry",
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.message).toBe(
      "restrict API socket /workspace/.jcode-home/run/jcode-api.sock\n\nCaused by:\n    Invalid argument (os error 22)",
    );
  });

  it("forwards a header-less orphan line as info instead of losing it", () => {
    expect(assemble(["thread 'main' panicked at src/main.rs:1"])).toEqual([
      {
        level: "info",
        at: "",
        message: "thread 'main' panicked at src/main.rs:1",
      },
    ]);
  });
});

describe("jcode INFO noise filter", () => {
  it.each([
    "Ambient runner: not time to run, sleeping 30s",
    "Ambient runner: nudged awake",
    "perf: tier=full terminal=unknown ssh=false",
    "[srv:grove] power_inhibit: monitoring active sessions",
    "[TIMING] provider_init: claude=false",
    "Runtime memory logging enabled: process=60s",
  ])("drops telemetry: %s", (message) => {
    expect(isInfoNoise(message)).toBe(true);
  });

  it.each([
    "[ses:session_bat_17908628|prv:Claude|mod:claude] EVENT event=AGENT_PROVIDER_STREAM_LIFECYCLE",
    "SERVER_INTERRUPT_CANCEL_IDLE_NOOP request_id=Some(9)",
    "Retrying Anthropic API request (attempt 2/3)",
    "[srv:grove] Server 🌳 grove starting (v0.81.1 (cae6d2a57))",
  ])("keeps operational events: %s", (message) => {
    expect(isInfoNoise(message)).toBe(false);
  });
});

describe("jcode log forwarder", () => {
  it("forwards this boot's entries through log(), never the previous boot's", () => {
    const { jcodeHome, file } = home();
    const follower = start(jcodeHome);
    appendFileSync(
      file,
      '[2026-10-01 13:54:16.105] [ERROR] [ses:s|prv:Claude|mod:claude] EVENT event=AGENT_PROVIDER_STREAM_LIFECYCLE error="Failed to send request"\n' +
        "[2026-10-01 13:54:16.107] [WARN] Processing task completed with error for message id=5\n" +
        "[2026-10-01 13:54:16.200] [INFO] Ambient runner: nudged awake\n",
    );
    follower.tick();
    expect(emitted()).toEqual([
      expect.objectContaining({
        level: "error",
        source: "jcode",
        jcodeTime: "2026-10-01 13:54:16.105",
        message: expect.stringContaining("AGENT_PROVIDER_STREAM_LIFECYCLE"),
      }),
      expect.objectContaining({
        level: "warn",
        source: "jcode",
        message: "Processing task completed with error for message id=5",
      }),
    ]);
  });

  it("redacts credentials before anything leaves the process", () => {
    const { jcodeHome, file } = home();
    const follower = start(jcodeHome);
    const token = `aoc_${"ab".repeat(32)}`;
    appendFileSync(
      file,
      `[2026-10-01 13:54:16.105] [WARN] proxy http://x:${token}@gateway:10255 refused\n`,
    );
    follower.tick();
    expect(stderr.join("")).not.toContain(token);
    expect(emitted()[0]?.message).toContain("aoc_[REDACTED]");
  });

  it("rate-caps a flood and reports the suppressed count on the next forwarded entry", () => {
    const { jcodeHome, file } = home();
    let now = 0;
    const follower = start(jcodeHome, { burst: 5, now: () => now });
    appendFileSync(
      file,
      Array.from(
        { length: 50 },
        (_, i) => `[2026-10-01 13:54:16.105] [WARN] flood ${i}\n`,
      ).join(""),
    );
    follower.tick();
    expect(emitted()).toHaveLength(5);
    now = 10_000;
    appendFileSync(file, "[2026-10-01 13:54:26.000] [ERROR] after the flood\n");
    follower.tick();
    expect(emitted().at(-1)).toEqual(
      expect.objectContaining({ message: "after the flood", suppressed: 45 }),
    );
  });

  it("bounds a single entry's size", () => {
    const { jcodeHome, file } = home();
    const follower = start(jcodeHome);
    appendFileSync(
      file,
      `[2026-10-01 13:54:16.105] [ERROR] ${"x".repeat(12_000)}\n`,
    );
    follower.tick();
    expect(emitted()[0]?.message).toHaveLength(MAX_ENTRY_CHARS);
  });
});

describe("jcode stderr forwarding", () => {
  it("forwards complete lines as warn with source jcode-stderr, redacted, and survives a stream error", () => {
    const stream = new PassThrough();
    forwardJcodeStderr(stream);
    stream.write("Starting server...\nError: restrict API soc");
    stream.write(`ket aoc_${"cd".repeat(32)}\n`);
    stream.emit("error", new Error("EPIPE"));
    expect(emitted()).toEqual([
      expect.objectContaining({
        level: "warn",
        source: "jcode-stderr",
        message: "Starting server...",
      }),
      expect.objectContaining({
        message: "Error: restrict API socket aoc_[REDACTED]",
      }),
    ]);
  });

  it("is a no-op without a stream (the SDK's stdio can be ignored)", () => {
    expect(() => forwardJcodeStderr(null)).not.toThrow();
  });
});
