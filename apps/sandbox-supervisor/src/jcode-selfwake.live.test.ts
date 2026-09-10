import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  SupervisorMessage,
  SupervisorTransport,
  WorkItem,
} from "@onecli/agent-protocol";

/**
 * THE SELF-WAKE INCIDENT SUITE — live, against the real jcode binary and the
 * real supervisor, with only the model provider mocked (a scripted provider
 * stands in for the model so runtime wake behavior becomes deterministic).
 *
 * The incident (2026-08-25, cloud): a lead agent armed the runtime's own
 * completion wake, its turn ended, and the daemon ran the resulting turn
 * with nobody subscribed — the answer streamed to no one, then leaked
 * mid-word into the next user turn. Two fixes cover it, both pinned here:
 * the spawn barrier (#962; its leak-quarantine regression proof lives in
 * the adapter unit suite, which drives the pre-fix frame shapes directly)
 * and EXTERNAL WAKE OWNERSHIP (v0.81+): the daemon can no longer run the
 * invisible turn at all. Scenario 1 proves that at the live boundary — a
 * completion with the runtime's wake flag produces ZERO extra model calls,
 * and the wake intent rides the platform's own mirror/watch machinery
 * instead. Scenario 2 pins the message separator (text → tool batch → text
 * renders as paragraphs, not glue) and the swarm-prompt override reaching
 * the model-visible tool description. Scenario 3 pins the disabled-tool
 * list at the same boundary: every name in JCODE_DISABLED_TOOLS_VALUE is
 * absent from the tool definitions the model receives, and the tools the
 * platform relies on are present.
 *
 * Env-gated like the incident suite — it needs a jcode runtime AT THE PIN
 * (v0.81.1; older binaries lack external wake mode):
 *
 *   JCODE_LIVE_TEST=1 ONECLI_JCODE_BINARY=<v0.81.1 binary> \
 *     pnpm --filter @onecli/sandbox-supervisor \
 *     exec vitest run src/jcode-selfwake.live.test.ts
 */
const LIVE = Boolean(process.env.JCODE_LIVE_TEST);

/** Injected into the managed config.toml by the writeManagedFile wrap. */
let mockProviderToml = "";

// The adapter rewrites config.toml at instance launch — wrap the shared
// managed write to add the mock provider profile and pin the default model
// route onto it, exactly as if the image shipped this provider.
vi.mock("./home/fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("./home/fs")>();
  return {
    ...original,
    writeManagedFile: (path: string, content: string, mode: number) => {
      if (path.endsWith("config.toml")) {
        content =
          content.replace(
            "[provider]\n",
            '[provider]\ndefault_model = "mockai:mock-model"\n',
          ) + mockProviderToml;
      }
      return original.writeManagedFile(path, content, mode);
    },
  };
});

const { createJcodeHarness, JCODE_DISABLED_TOOLS_VALUE } =
  await import("./harness/jcode");
const { runSupervisor } = await import("./supervisor");
const { startMockProvider } = await import("./harness/testing/mock-provider");
type MockScript = import("./harness/testing/mock-provider").MockScript;

interface Stamped {
  at: number;
  message: SupervisorMessage;
}

const createTransport = () => {
  const sent: Stamped[] = [];
  const queue: WorkItem[] = [];
  let notify: (() => void) | undefined;
  return {
    sent,
    push(item: WorkItem) {
      queue.push(item);
      notify?.();
      notify = undefined;
    },
    resultsOf(turnId: string) {
      return sent
        .filter(
          (s) =>
            s.message.kind === "turn.result" && s.message.turnId === turnId,
        )
        .map((s) => ({
          at: s.at,
          result: s.message as Extract<
            SupervisorMessage,
            { kind: "turn.result" }
          >,
        }));
    },
    eventsOf(turnId: string) {
      return sent
        .filter(
          (s) => s.message.kind === "event" && s.message.turnId === turnId,
        )
        .map((s) => s.message as Extract<SupervisorMessage, { kind: "event" }>);
    },
    /** The coalesced answer row alone — what the transcript stores. */
    answerOf(turnId: string) {
      return this.eventsOf(turnId)
        .filter((m) => m.event.type === "text")
        .map((m) => (m.event as { text: string }).text)
        .join("");
    },
    textOf(turnId: string) {
      return this.eventsOf(turnId)
        .filter((m) => m.event.type === "text" || m.event.type === "text.delta")
        .map((m) => (m.event as { text: string }).text)
        .join("");
    },
    noticesOf(turnId: string) {
      return this.eventsOf(turnId)
        .filter((m) => m.event.type === "notice")
        .map((m) => m.event as { level: string; text: string });
    },
    async until(predicate: () => boolean, label: string, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    transport: {
      async *incoming(): AsyncIterable<WorkItem> {
        for (;;) {
          while (queue.length > 0) {
            const item = queue.shift();
            if (!item) continue;
            yield item;
            if (item.kind === "shutdown") return;
          }
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      },
      send(message: SupervisorMessage) {
        sent.push({ at: Date.now(), message });
      },
      close() {
        return Promise.resolve();
      },
    } satisfies SupervisorTransport,
  };
};

const stubHarvester = {
  poll: async () => undefined,
  harvestFile: async () => "refused" as const,
  forgetFile: () => undefined,
  handleResult: () => undefined,
  stop: () => undefined,
};

/** A short /tmp home — the daemon binds a unix socket under it, and macOS's
 * /var/folders tmpdir overflows SUN_LEN (proven in the incident repro). */
const shortHome = () => mkdtempSync("/tmp/ocl-");

const supervisorConfig = (homeDir: string) => ({
  homeDir,
  model: "mock-model",
  effort: "low" as const,
  instructions: "self-wake regression agent",
  agentName: "Donna",
  harness: "jcode",
  runnerWsUrl: undefined,
  bootstrapToken: undefined,
});

const deliver = (
  turnId: string,
  conversationId: string,
  message: string,
): WorkItem => ({ kind: "turn.deliver", turnId, conversationId, message });

const withMock = async (
  script: MockScript,
  body: (mock: Awaited<ReturnType<typeof startMockProvider>>) => Promise<void>,
) => {
  const mock = await startMockProvider({
    longMs: 60_000,
    keepaliveMs: 5_000,
    script,
  });
  mockProviderToml = `
[providers.mockai]
type = "openai-compatible"
base_url = "http://127.0.0.1:${mock.port}/v1"
api_key = "sk-mock"
default_model = "mock-model"
models = [{ id = "mock-model" }]
`;
  try {
    await body(mock);
  } finally {
    await mock.close();
  }
};

describe("jcode self-wake live gate", () => {
  // vitest errors on a file with no runnable tests, so the gate holds one
  // cheap assertion for the skipped case (the conformance file's pattern).
  it.skipIf(!LIVE)("declares the capabilities the scenarios lean on", () => {
    expect(createJcodeHarness().capabilities).toMatchObject({
      resume: true,
      steer: true,
    });
  });
});

describe.skipIf(!LIVE)("external wake ownership (live jcode)", () => {
  it("a runtime wake flag produces ZERO shadow model calls — the wake rides the platform mirror", async () => {
    // Scenario 1 — the incident's trigger, defused at the engine. Turn 1
    // arms a background bash task WITH the runtime's own wake flag (exactly
    // what the incident's lead did via its fan-out await). Pre-v0.81 the
    // daemon then ran an invisible turn on completion — a real model call
    // whose output reached no one. Under JCODE_WAKE_MODE=external that turn
    // CANNOT happen: the mock provider must see no request beyond the two
    // that served the arming turn, and the wake intent must surface through
    // the platform's own machinery (the registry mirror's implicit watch,
    // triggered on exit) — the handoff the control plane turns into a
    // visible wake turn.
    let armCalls = 0;
    const script: MockScript = ({ lastUser }) => {
      if (lastUser.includes("ARM-WAKE")) {
        armCalls += 1;
        if (armCalls === 1) {
          return {
            kind: "tool_call",
            name: "bash",
            argsJson: JSON.stringify({
              command: "sleep 2; echo wake-bait-done",
              run_in_background: true,
              notify: true,
              wake: true,
            }),
            tag: "arm",
          };
        }
        return { kind: "text", text: "armed.", tag: "armed" };
      }
      if (lastUser.includes("NO-LEAK-CHECK")) {
        return { kind: "text", text: "THE-ANSWER-T2 all clear.", tag: "t2" };
      }
      // Any OTHER request is a shadow turn — the exact defect. Serve it
      // with an unmissable marker so the assertion below names it.
      return { kind: "text", text: "SHADOW-TURN-RAN", tag: "shadow" };
    };

    await withMock(script, async (mock) => {
      const t = createTransport();
      const run = runSupervisor(
        supervisorConfig(shortHome()),
        createJcodeHarness(),
        t.transport,
        { memoryHarvester: stubHarvester },
      );
      try {
        t.push(
          deliver(
            "t-arm",
            "cv-wake",
            "ARM-WAKE: start the background probe, then reply exactly 'armed.'",
          ),
        );
        await t.until(
          () => t.resultsOf("t-arm").some((r) => r.result.status === "done"),
          "the arming turn to finish",
          60_000,
        );
        expect(t.textOf("t-arm")).toContain("armed.");

        // The task completes at ~2s. The platform mirror picks it up and
        // the implicit wake watch (armed from the task's wake intent) goes
        // triggered — the visible handoff to the control plane.
        await t.until(
          () =>
            t.sent.some(
              (s) =>
                s.message.kind === "process.state" &&
                s.message.process.watches.some((w) => w.status === "triggered"),
            ),
          "the wake intent to surface as a triggered platform watch",
          60_000,
        );

        // THE ENGINE PIN: no shadow turn dialed the model. Give the old
        // behavior time to have fired (it fired within ~1s pre-v0.81).
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        expect(mock.requests.filter((r) => r.tag === "shadow")).toHaveLength(0);

        // A follow-up user turn is clean: no foreign output, no exclusion
        // notice (nothing ran to be excluded), no health noise.
        t.push(deliver("t-user", "cv-wake", "NO-LEAK-CHECK did it finish?"));
        await t.until(
          () => t.resultsOf("t-user").length > 0,
          "the user turn to finish",
          120_000,
        );
        expect(t.resultsOf("t-user")[0]?.result.status).toBe("done");
        const answer = t.answerOf("t-user");
        expect(answer).toContain("THE-ANSWER-T2");
        expect(answer).not.toContain("SHADOW");
        expect(t.noticesOf("t-user")).toHaveLength(0);
        expect(t.sent.filter((s) => s.message.kind === "unhealthy")).toEqual(
          [],
        );
      } finally {
        t.push({ kind: "shutdown" });
        await run;
      }
    });
  }, 240_000);

  it("stores the agent's LAST message as the answer, never glued to its narration", async () => {
    // Scenario 2 — the message boundary, at the live boundary. One turn:
    // text, a foreground tool call, more text.
    //
    // This pinned the SEPARATOR before ("Part one.\n\nPart two.") — the fix
    // for text glued mid-sentence. The separator was the right repair for a
    // rendering bug but the wrong contract: mid-turn text is the agent
    // narrating its work, and joining it to the closing message published
    // running commentary as the answer (the multi-screen chat walls, live).
    // Now the LAST message is the answer, so the anti-glue guarantee holds
    // by construction — "Part one." cannot touch "Part two." if it is not
    // in the answer at all — and both halves are still asserted below.
    let sepCalls = 0;
    const script: MockScript = ({ lastUser }) => {
      if (!lastUser.includes("SEP-CHECK")) return undefined;
      sepCalls += 1;
      if (sepCalls === 1) {
        return {
          kind: "tool_call",
          name: "bash",
          argsJson: JSON.stringify({ command: "echo sep-probe" }),
          textBefore: "Part one.",
          tag: "sep-tool",
        };
      }
      return { kind: "text", text: "Part two.", tag: "sep-final" };
    };

    await withMock(script, async (mock) => {
      const t = createTransport();
      const run = runSupervisor(
        supervisorConfig(shortHome()),
        createJcodeHarness(),
        t.transport,
        { memoryHarvester: stubHarvester },
      );
      try {
        t.push(deliver("t-sep", "cv-sep", "SEP-CHECK run the probe"));
        await t.until(
          () => t.resultsOf("t-sep").some((r) => r.result.status === "done"),
          "the separator turn to finish",
          60_000,
        );
        expect(mock.requests.some((r) => r.tag === "sep-final")).toBe(true);
        // The closing message IS the answer, alone.
        expect(t.answerOf("t-sep")).toBe("Part two.");
        // The original bug's shape can never come back: the narration is not
        // in the stored answer, glued or otherwise.
        expect(t.answerOf("t-sep")).not.toContain("Part one.Part two.");
        expect(t.answerOf("t-sep")).not.toContain("Part one.");

        // SWARM-PROMPT TRIPWIRE: the platform's override must be what the
        // MODEL actually sees as the fan-out tool's description — not the
        // builtin (which advertises a per-spawn model that no longer exists
        // and names vendor models). Captured off the real request bodies.
        const descriptions = mock.requests
          .map((r) => r.swarmToolDescription)
          .filter((d): d is string => d !== undefined);
        expect(descriptions.length).toBeGreaterThan(0);
        for (const description of descriptions) {
          // The override wraps lines; compare on normalized whitespace.
          expect(description.replace(/\s+/g, " ")).toContain(
            "There is no per-helper model choice",
          );
          // No vendor-model routing strings (the builtin advertised
          // model=claude-api:…). The daemon's own wrapper line names its
          // config path — upstream bytes, outside this law's scope.
          expect(description).not.toMatch(/claude-api|fable/i);
        }
      } finally {
        t.push({ kind: "shutdown" });
        await run;
      }
    });
  }, 240_000);

  it("the disabled tools are ABSENT from what the model sees; the load-bearing ones are present", async () => {
    // Scenario 3 — the JCODE_DISABLED_TOOLS pin at the live boundary. The
    // unit pins assert the STRING the launch env carries; only the real
    // daemon can prove that string removes the definitions from the request
    // body the model receives (the adapter header's "disabling is safe
    // because a disabled tool is REMOVED from the model-visible tool list"
    // claim, verified upstream for `gmail` — here for every entry, including
    // `browser`, whose removal is the 2026-09-09 trap fix). Captured off the
    // real request bodies, same tripwire shape as the swarm description.
    //
    // TWO turns, asserted on the second: the daemon connects the platform-
    // tools MCP server asynchronously (~100 ms, measured) and "locks the
    // tool list for cache stability" per turn, so a fresh session's FIRST
    // request carries only the native tools (23 at v0.81.1) and the
    // platform's 17 join once the bridge is up (40). A real turn takes
    // seconds and never notices; this scripted mock answers in ~5 ms, so
    // the test waits for the bridge before the second turn — the same
    // ordering production gets for free. The disabled-list law holds on
    // both requests; the platform-tool presence law is the second-turn fact.
    const script: MockScript = ({ lastUser }) =>
      lastUser.includes("TOOLS-CHECK")
        ? {
            kind: "text",
            text: "tools-seen",
            tag: lastUser.includes("SECOND") ? "tools-second" : "tools-first",
          }
        : undefined;

    await withMock(script, async (mock) => {
      const t = createTransport();
      const home = shortHome();
      const run = runSupervisor(
        supervisorConfig(home),
        createJcodeHarness(),
        t.transport,
        { memoryHarvester: stubHarvester },
      );
      try {
        t.push(deliver("t-tools-1", "cv-tools", "TOOLS-CHECK say tools-seen"));
        await t.until(
          () =>
            t.resultsOf("t-tools-1").some((r) => r.result.status === "done"),
          "the first tools turn to finish",
          60_000,
        );
        // The bridge's own readiness signal: the daemon appends the MCP
        // connect to its log. Poll for it rather than sleeping a guess.
        const daemonLog = () =>
          readdirSync(join(home, ".jcode-home", "logs"), {
            withFileTypes: true,
          })
            .filter((e) => e.isFile())
            .map((e) =>
              readFileSync(join(home, ".jcode-home", "logs", e.name), "utf8"),
            )
            .join("\n");
        await t.until(
          () => daemonLog().includes("MCP: Connected to 'onecli'"),
          "the platform-tools bridge to connect",
          30_000,
        );
        t.push(
          deliver("t-tools-2", "cv-tools", "TOOLS-CHECK SECOND say tools-seen"),
        );
        await t.until(
          () =>
            t.resultsOf("t-tools-2").some((r) => r.result.status === "done"),
          "the second tools turn to finish",
          60_000,
        );
        const first = mock.requests.find((r) => r.tag === "tools-first");
        const second = mock.requests.find((r) => r.tag === "tools-second");
        expect(first).toBeDefined();
        expect(second).toBeDefined();

        // Every disabled name, absent from EVERY request — the constant IS
        // the launch env, so this reads the same list the daemon parsed.
        for (const request of [first, second]) {
          const names = new Set(request?.toolNames);
          expect(names.size).toBeGreaterThan(0);
          for (const disabled of JCODE_DISABLED_TOOLS_VALUE.split(",")) {
            expect(
              names.has(disabled),
              `disabled tool ${disabled} leaked`,
            ).toBe(false);
          }
        }

        // The tools the platform's own contracts lean on, present by the
        // second turn: bash (the agent's hands), bg (observed, deliberately
        // NOT disabled), swarm (fan-out always on), and the platform tools
        // themselves — advertised as `mcp__onecli__<name>` at this version
        // (server name from prepareMcpConfig, then the bridge's tool name).
        const names = new Set(second?.toolNames);
        for (const required of [
          "bash",
          "bg",
          "swarm",
          "mcp__onecli__process_start",
          "mcp__onecli__process_watch",
          "mcp__onecli__memory_save",
        ]) {
          expect(names.has(required), `required tool ${required} missing`).toBe(
            true,
          );
        }
        // And the platform tools genuinely joined (23 native → 40 total at
        // the pin); a stuck-at-native second turn means the bridge is down.
        expect(names.size).toBeGreaterThan(first?.toolNames.length ?? 0);
      } finally {
        t.push({ kind: "shutdown" });
        await run;
      }
    });
  }, 240_000);
});
