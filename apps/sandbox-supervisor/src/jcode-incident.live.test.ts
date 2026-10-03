import { mkdtempSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  SupervisorMessage,
  SupervisorTransport,
  WorkItem,
} from "@onecli/agent-protocol";

/**
 * THE STUCK-SANDBOX INCIDENT REGRESSION SUITE — live, against the real jcode
 * binary and the real supervisor, with only the model provider mocked (a
 * slow SSE stream stands in for the incident's CI-watching turn).
 *
 * The incident (2026-08-25, self-host): one long turn; a second conversation
 * attached to its BUSY session, two 30s control-op timeouts became false
 * "model isn't available" notices, the busy refusal's broadcast error frame
 * failed the live turn 23 minutes early with an empty error, every follow-up
 * died silently in ~150ms, and the finished answer was discarded. Each
 * scenario here asserts the FIXED behavior; each failed on the pre-fix tree.
 *
 * Env-gated like the live conformance run — it needs a jcode runtime
 * (ONECLI_JCODE_BINARY, or the SDK's bundled platform binary):
 *
 *   JCODE_LIVE_TEST=1 pnpm --filter @onecli/sandbox-supervisor \
 *     exec vitest run src/jcode-incident.live.test.ts
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

const { createJcodeHarness } = await import("./harness/jcode");
const { runSupervisor } = await import("./supervisor");
const { startMockProvider, FINAL_ANSWER_MARKER, LONG_RUN_MARKER } =
  await import("./harness/testing/mock-provider");
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
      return sent.filter(
        (s) => s.message.kind === "event" && s.message.turnId === turnId,
      );
    },
    textOf(turnId: string) {
      return this.eventsOf(turnId)
        .map((s) => s.message as Extract<SupervisorMessage, { kind: "event" }>)
        .filter((m) => m.event.type === "text" || m.event.type === "text.delta")
        .map((m) => (m.event as { text: string }).text)
        .join("");
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
  instructions: "incident regression agent",
  agentName: "Donna",
  channels: [],
  peers: [],
  connections: [],
  harness: "jcode",
  runnerWsUrl: undefined,
  bootstrapToken: undefined,
  outboundAttachments: false,
});

const deliver = (
  turnId: string,
  conversationId: string,
  message: string,
): WorkItem => ({ kind: "turn.deliver", turnId, conversationId, message });

const withMock = async (
  longMs: number,
  body: (mock: Awaited<ReturnType<typeof startMockProvider>>) => Promise<void>,
  script?: MockScript,
) => {
  const mock = await startMockProvider({
    longMs,
    keepaliveMs: 5_000,
    ...(script && { script }),
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

describe("jcode incident live gate", () => {
  // vitest errors on a file with no runnable tests, so the gate holds one
  // cheap assertion for the skipped case (the conformance file's pattern).
  it.skipIf(!LIVE)("declares the capabilities the scenarios lean on", () => {
    expect(createJcodeHarness().capabilities).toMatchObject({
      resume: true,
      steer: true,
    });
  });
});

describe.skipIf(!LIVE)("the stuck-sandbox incident, fixed (live jcode)", () => {
  it("a second conversation runs CONCURRENTLY and the long turn's answer is delivered", async () => {
    // The incident timeline with the fixed expectations: B gets its OWN
    // session instantly (no 30s control-op deferrals — the bug's timing
    // fingerprint), both turns complete, nothing fails, and A's final
    // answer reaches the transport instead of being discarded.
    await withMock(40_000, async () => {
      const t = createTransport();
      const run = runSupervisor(
        supervisorConfig(shortHome()),
        createJcodeHarness(),
        t.transport,
        { memoryHarvester: stubHarvester },
      );

      try {
        t.push(deliver("t-a", "cv-a", `${LONG_RUN_MARKER} watch the CI`));
        await t.until(
          () => t.eventsOf("t-a").length > 0,
          "conversation A to start streaming",
          60_000,
        );

        const bPushedAt = Date.now();
        t.push(deliver("t-b", "cv-b", "hey, what are you working on?"));
        await t.until(
          () => t.resultsOf("t-b").length > 0,
          "conversation B's result",
          30_000,
        );

        const [b] = t.resultsOf("t-b");
        // B completed fast — pre-fix this took 60s of timeouts and failed.
        expect(b!.result.status).toBe("done");
        expect(b!.at - bPushedAt).toBeLessThan(15_000);
        expect(t.textOf("t-b")).toContain("Quick answer");

        // A keeps running to completion — pre-fix it was failed the moment
        // B's refusal frame landed in its stream.
        await t.until(
          () => t.resultsOf("t-a").length > 0,
          "conversation A's result",
          90_000,
        );
        const [a] = t.resultsOf("t-a");
        expect(a!.result.status).toBe("done");
        expect(t.textOf("t-a")).toContain(FINAL_ANSWER_MARKER);

        // The collision itself: distinct sessions per conversation.
        expect(a!.result.sessionRef).toBeDefined();
        expect(b!.result.sessionRef).toBeDefined();
        expect(a!.result.sessionRef).not.toBe(b!.result.sessionRef);
      } finally {
        t.push({ kind: "shutdown" });
        await run;
      }
      // An ordinary shutdown closes N connections and the instance — none of
      // that may read as a harness death (the disposing-flag ordering this
      // restructure depends on).
      expect(t.sent.filter((s) => s.message.kind === "unhealthy")).toHaveLength(
        0,
      );
    });
  }, 240_000);

  it("an abandoned run is self-healed away — the next message still gets its answer", async () => {
    // The follow-up shape: the platform walked away from a turn (here, by
    // abandoning the iterator — the pre-fix supervisor did exactly this
    // when the refusal frame killed its stream) while the daemon kept
    // executing. The NEXT message hits the busy session; the self-heal
    // cancels the orphan and resends. Pre-fix: failed in ~150ms, empty
    // error, six times in a row.
    await withMock(120_000, async (mock) => {
      const harness = createJcodeHarness();
      let failure: string | undefined;
      harness.onFailure((reason) => {
        failure = reason;
      });
      const homeDir = shortHome();
      try {
        const session = await harness.startSession({
          homeDir,
          model: "mock-model",
        });

        const first = session
          .runTurn({ message: `${LONG_RUN_MARKER} watch the CI` })
          [Symbol.asyncIterator]();
        // Consume just past the send, then walk away mid-run.
        await first.next();
        await t0Streaming(mock);
        await first.return?.(undefined);

        const events = [];
        for await (const event of session.runTurn({
          message: "quick status please",
        })) {
          events.push(event);
        }

        expect(events.at(-1)?.type).toBe("turn.done");
        const text = events
          .filter((e) => e.type === "text.delta")
          .map((e) => (e as { text: string }).text)
          .join("");
        expect(text).toContain("Quick answer");
        // The abandoned orphan and its cancel are one turn's business —
        // never a harness death.
        expect(failure).toBeUndefined();
      } finally {
        await harness.dispose();
      }
    });
  }, 240_000);

  it("resume-by-ref works across container lives — the restart shape, live", async () => {
    // A conversation resumes by sessionRef only in a FRESH container (the
    // supervisor caches live sessions in-process), so the first harness is
    // disposed before the second resumes on the same home — verified here
    // against the real bridge, not the mock. A resume ref held by a LIVE
    // conversation is corrupted duplicate data and mints fresh instead (the
    // adapter unit suite pins that arm).
    await withMock(20_000, async () => {
      const homeDir = shortHome();
      const first = createJcodeHarness();
      let ref: string | null | undefined;
      try {
        const session = await first.startSession({
          homeDir,
          model: "mock-model",
        });
        ref = session.sessionRef;
        if (!ref) throw new Error("expected a session ref");
        // A quick turn proves the session serves before the restart.
        for await (const event of session.runTurn({ message: "warm up" })) {
          if (event.type === "error") {
            throw new Error(`warm-up failed: ${event.message}`);
          }
        }
      } finally {
        await first.dispose();
      }

      const second = createJcodeHarness();
      try {
        const resumed = await second.startSession({
          homeDir,
          model: "mock-model",
          resumeSessionRef: ref,
        });
        expect(resumed.sessionRef).toBe(ref);

        const events = [];
        for await (const event of resumed.runTurn({
          message: "still there?",
        })) {
          events.push(event);
        }
        expect(events.at(-1)?.type).toBe("turn.done");
      } finally {
        await second.dispose();
      }
    });
  }, 240_000);

  it("a message steered into the live long turn JOINS it — never purged, never lost", async () => {
    // The mid-turn messages the user sent "while it was working": they ride
    // soft interrupts into the run and must reconcile as joined on the
    // terminal report. Pre-fix, the false failure purged the queue and the
    // re-run died against the busy session.
    await withMock(20_000, async () => {
      const t = createTransport();
      const run = runSupervisor(
        supervisorConfig(shortHome()),
        createJcodeHarness(),
        t.transport,
        { memoryHarvester: stubHarvester },
      );

      try {
        t.push(deliver("t-a", "cv-a", `${LONG_RUN_MARKER} watch the CI`));
        await t.until(
          () => t.eventsOf("t-a").length > 0,
          "the long turn to start",
          60_000,
        );
        t.push({
          kind: "turn.message",
          turnId: "f-1",
          targetTurnId: "t-a",
          conversationId: "cv-a",
          message: "also check the linter output",
        });

        await t.until(
          () => t.resultsOf("t-a").length > 0,
          "the long turn's result",
          120_000,
        );
        const [a] = t.resultsOf("t-a");
        expect(a!.result.status).toBe("done");
        expect(a!.result.followUps).toEqual([
          { turnId: "f-1", outcome: "joined" },
        ]);
      } finally {
        t.push({ kind: "shutdown" });
        await run;
      }
    });
  }, 240_000);

  it("a Slack presence attached MID-RUN reaches the live conversation's next turn — the doc AND the tools the model sees (the dev incident, 2026-09-15)", async () => {
    // Observed live: an agent whose session was already awake had Slack
    // attached; the home sync re-rendered CLAUDE.md, but jcode captures the
    // instruction doc and the MCP tool list at session start, so the same
    // session kept telling a Slack user it had no Slack access. The mock
    // provider records the system prompt and tool list of EVERY request —
    // the only ground truth for "what did the model see this turn".
    await withMock(1_000, async (mock) => {
      const homeDir = shortHome();
      const t = createTransport();
      const run = runSupervisor(
        supervisorConfig(homeDir),
        createJcodeHarness(),
        t.transport,
        { memoryHarvester: stubHarvester },
      );
      const saw = (request: (typeof mock.requests)[number]) => ({
        whereYouTalk:
          /## Where you talk/.test(request.systemText) &&
          request.systemText.includes("Acme"),
        sendMessage: request.toolNames.some((n) => n.endsWith("send_message")),
      });
      try {
        // Turn 1, no presence: neither the section nor the tool.
        t.push(deliver("t1", "cv", "hello"));
        await t.until(() => t.resultsOf("t1").length > 0, "turn 1", 90_000);
        expect(saw(mock.requests.at(-1)!)).toEqual({
          whereYouTalk: false,
          sendMessage: false,
        });

        // Slack attached while the session is live (the home sync's part).
        t.push({
          kind: "skills.changed",
          generation: 2,
          part: 1,
          of: 1,
          files: [],
          prune: [],
          channels: [
            {
              provider: "slack",
              status: "active",
              handle: "donna",
              workspaceName: "Acme",
            },
          ],
        });
        await t.until(
          () => t.sent.some((s) => s.message.kind === "home.synced"),
          "home.synced",
          30_000,
        );

        // Turn 2 on the SAME conversation: the restarted session's prompt is
        // built from disk synchronously, so the DOC is fresh on its very
        // first request. The TOOLS follow the harness's own MCP discovery,
        // which can lag a fresh session's first request (the selfwake live
        // pin states the contract as "present by the second turn"); so the
        // tool assertion is made on the turn after — the same boundary the
        // rest of the platform's tool pins use.
        t.push(deliver("t2", "cv", "do you have access to slack?"));
        await t.until(() => t.resultsOf("t2").length > 0, "turn 2", 90_000);
        const second = mock.requests.at(-1)!;
        expect(saw(second).whereYouTalk).toBe(true);
        // ...on the same session ref: the transcript survived the restart.
        expect(t.resultsOf("t2")[0]!.result.sessionRef).toBe(
          t.resultsOf("t1")[0]!.result.sessionRef,
        );
        t.push(deliver("t2b", "cv", "and can you send me a message there?"));
        await t.until(() => t.resultsOf("t2b").length > 0, "turn 2b", 90_000);
        expect(saw(mock.requests.at(-1)!)).toEqual({
          whereYouTalk: true,
          sendMessage: true,
        });
        expect(t.resultsOf("t2b")[0]!.result.sessionRef).toBe(
          t.resultsOf("t1")[0]!.result.sessionRef,
        );

        // The reverse move: the app is removed while the session is live.
        // Turn 3 must see the removed copy and LOSE send_message — an agent
        // whose app is gone must not keep a tool that would fail.
        t.push({
          kind: "skills.changed",
          generation: 3,
          part: 1,
          of: 1,
          files: [],
          prune: [],
          channels: [
            {
              provider: "slack",
              status: "disabled",
              handle: "donna",
              workspaceName: "Acme",
            },
          ],
        });
        await t.until(
          () =>
            t.sent.filter((s) => s.message.kind === "home.synced").length >= 2,
          "second home.synced",
          30_000,
        );
        t.push(deliver("t3", "cv", "can you message me on slack?"));
        await t.until(() => t.resultsOf("t3").length > 0, "turn 3", 90_000);
        const third = mock.requests.at(-1)!;
        expect(third.systemText).toContain("was removed from the workspace");
        expect(t.resultsOf("t3")[0]!.result.sessionRef).toBe(
          t.resultsOf("t1")[0]!.result.sessionRef,
        );
        t.push(deliver("t3b", "cv", "are you sure?"));
        await t.until(() => t.resultsOf("t3b").length > 0, "turn 3b", 90_000);
        const settled = mock.requests.at(-1)!;
        expect(settled.systemText).toContain("was removed from the workspace");
        // What jcode does on a resumed session after a presence is withdrawn.
        // Through v0.81.1 (observed live, 2026-09-15) its tool registry was a
        // UNION across attaches: withdrawn messaging tools stayed LISTED to
        // the model. From v0.90.0 (re-run live 2026-10-01 at the pin bump)
        // the withdrawn tools are DROPPED from the request, so the model no
        // longer sees a tool it cannot use. The doc (asserted above) and the
        // platform-tools socket's explanatory refusal (pinned in
        // platform-tools.test.ts) remain as defence in depth. The tools that
        // were never withdrawn must still be present.
        expect(settled.toolNames.some((n) => n.endsWith("send_message"))).toBe(
          false,
        );
        expect(settled.toolNames.some((n) => n.endsWith("memory_save"))).toBe(
          true,
        );
      } finally {
        t.push({ kind: "shutdown" });
        await run;
      }
    });
  }, 240_000);
});

describe.skipIf(!LIVE)(
  "issue #1124 — the frame fence vs the daemon's get_history race (live jcode)",
  () => {
    it("turns whose reply outlasts the request loop: every one completes, none loses its own output", async () => {
      // THE PROD SIGNATURE, reproduced against the real daemon. Each turn
      // sends a message and, right behind it, a get_history (the reconcile
      // baseline). Inside the daemon the get_history handler probes the
      // agent mutex with try_lock and then takes it for real; when the probe
      // wins the race against the turn task by microseconds, the history
      // reply blocks for the WHOLE TURN and lands after the turn's `done`
      // (jcode#1284). Measured live: 3 of 18 turns in prod; here, with a
      // 20-turn loop, the daemon log shows the locked path taken on most.
      //
      // The reply must outlast the daemon's request-loop latency for the
      // race to matter (a 4 ms turn's history lands before the adapter has
      // even read the terminal), so each reply is streamed over ~1.2 s — the
      // prod turns took 8 to 15 s. Pre-fix the adapter used the history
      // reply as its frame fence, quarantined its own entire turn including
      // the terminal, minted the "background run overlapped" notice for its
      // own answer, and hung until the control plane's sweep. The fixed
      // fence is `message_accepted`: 20/20 complete, 0 notices.
      const TURNS = 20;
      const script: MockScript = ({ lastUser }) =>
        lastUser.includes("slow-reply")
          ? {
              kind: "text",
              tag: "slow",
              text: " Quick answer",
              slow: { chunks: ["Thinking", ".", ".", "."], intervalMs: 300 },
            }
          : undefined;
      await withMock(
        20_000,
        async (mock) => {
          const harness = createJcodeHarness();
          let failure: string | undefined;
          harness.onFailure((reason) => {
            failure = reason;
          });
          const homeDir = shortHome();
          try {
            const session = await harness.startSession({
              homeDir,
              model: "mock-model",
            });
            const durations: number[] = [];
            let notices = 0;
            for (let i = 0; i < TURNS; i += 1) {
              const started = Date.now();
              const events: AgentEvent[] = [];
              for await (const event of session.runTurn({
                message: `slow-reply status please #${i}`,
              })) {
                events.push(event);
              }
              durations.push(Date.now() - started);
              const terminal = events.at(-1);
              expect(terminal?.type, `turn #${i} terminal`).toBe("turn.done");
              const text = events
                .filter((e) => e.type === "text.delta")
                .map((e) => (e as { text: string }).text)
                .join("");
              expect(text, `turn #${i} text`).toContain("Quick answer");
              notices += events.filter((e) => e.type === "notice").length;
            }
            // Each turn is ~1.5 s of streaming; one that took much longer was
            // waiting on a lost terminal (the pre-fix shape, bounded only by
            // the ceiling).
            expect(Math.max(...durations)).toBeLessThan(10_000);
            // Not one turn mistook its own answer for a background run's.
            expect(notices).toBe(0);
            expect(
              mock.requests.filter(
                (r) => r.kind === "scripted" && r.tag === "slow",
              ),
            ).toHaveLength(TURNS);
            expect(failure).toBeUndefined();
          } finally {
            await harness.dispose();
          }
        },
        script,
      );
    }, 300_000);

    it("Stop on a session whose daemon has nothing to cancel ends within the abort grace", async () => {
      // The user's three Stops in #1124 all reached the daemon and were
      // answered NO_LOCAL_TASK / IDLE_NOOP: nothing was running. Reproduced:
      // a turn whose model reply is held open, then a cancel that the daemon
      // honours normally — and, separately, the adapter's own grace when the
      // daemon's terminal never comes (unit-pinned; here the live half).
      await withMock(60_000, async (mock) => {
        const harness = createJcodeHarness();
        const homeDir = shortHome();
        try {
          const session = await harness.startSession({
            homeDir,
            model: "mock-model",
          });
          const iterator = session
            .runTurn({ message: `${LONG_RUN_MARKER} hold the line` })
            [Symbol.asyncIterator]();
          const events: AgentEvent[] = [];
          // Read until the run is live at the mock, on a side task.
          const drained = (async () => {
            let next = await iterator.next();
            while (!next.done) {
              events.push(next.value);
              next = await iterator.next();
            }
          })();
          await t0Streaming(mock);
          const abortedAt = Date.now();
          await session.abort();
          await drained;
          expect(events.at(-1)?.type).toBe("turn.done");
          // The daemon's cooperative cancel: well inside the grace.
          expect(Date.now() - abortedAt).toBeLessThan(5_000);
        } finally {
          await harness.dispose();
        }
      });
    }, 120_000);
  },
);

/** Wait until the mock has served the long request (the run is truly live). */
const t0Streaming = async (
  mock: Awaited<ReturnType<typeof startMockProvider>>,
) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (mock.requests.some((request) => request.kind === "long")) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the long run never reached the mock provider");
};
