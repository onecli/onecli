import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdapterConfigResponse,
  AdapterDecisionRequest,
  AdapterIngestRequest,
  AdapterIngestResponse,
  AdapterPresence,
  AdapterWorkItem,
  AdapterWorkTurn,
} from "@onecli/agent-protocol";
import { createAdapter } from "./adapter";
import type { AdapterConfig } from "./config";
import type { ControlPlaneClient } from "./control-plane";
import { FakeSocket } from "./test/fake-socket";
import {
  createFakeControlPlane,
  settle,
  startFakeGatewayServer,
  startFakeSlackServer,
  waitReal,
  type FakeGatewayServer,
  type FakeSlackServer,
} from "./test/fakes";

/**
 * The orchestrator with every seam faked: a hand-fed config feed and work
 * poll (the ControlPlaneClient interface), a recording Slack server behind
 * SLACK_API_BASE_URL, a scripted gateway, and — because `openSocket`
 * deliberately builds real sockets — the global WebSocket stubbed with the
 * FakeSocket class. What these prove is the division of labour: the config
 * feed owns connections, the completion pass posts each finished turn
 * exactly once, and Slack clicks only ever carry an opaque approval id
 * inward.
 */

const sockets: FakeSocket[] = [];
class CapturingSocket extends FakeSocket {
  constructor(url: string) {
    super(url);
    sockets.push(this);
  }
}

let slack: FakeSlackServer;
let gateway: FakeGatewayServer;
let adapters: ReturnType<typeof createAdapter>[];

beforeEach(async () => {
  slack = await startFakeSlackServer();
  gateway = await startFakeGatewayServer();
  process.env.SLACK_API_BASE_URL = slack.url;
  sockets.length = 0;
  adapters = [];
  vi.stubGlobal("WebSocket", CapturingSocket);
});

afterEach(async () => {
  for (const adapter of adapters) adapter.stop();
  vi.unstubAllGlobals();
  // A few tests fake the timer families (the retry backoff sweep); restore
  // real timers before the real-I/O server teardown below.
  vi.useRealTimers();
  delete process.env.SLACK_API_BASE_URL;
  await gateway.close();
  await slack.close();
});

const adapterConfig = (): AdapterConfig => ({
  token: "cha_test",
  name: "test adapter",
  controlPlaneUrl: "http://127.0.0.1:1",
  gatewayUrl: gateway.url,
  configPollMs: 25,
  workPollMs: 25,
  approvalsPollSeconds: 1,
  appUrl: "https://app.example.com",
  appUrlFromLegacyBind: false,
});

const presence = (
  overrides: Partial<AdapterPresence> = {},
): AdapterPresence => ({
  presenceId: "p1",
  provider: "slack",
  transport: "socket",
  status: "active",
  externalId: "B123",
  identityRef: null,
  agent: { id: "ag1", name: "Deploy Agent", workspaceId: "proj1" },
  tenant: { externalId: "T1", name: "Acme" },
  credentialsJson: JSON.stringify({
    botToken: "xoxb-bot",
    appToken: "xapp-app",
  }),
  approvalsKey: null,
  links: [
    {
      id: "l1",
      conversationId: "cv1",
      externalThreadId: "D100",
      kind: "direct",
      externalUserId: "U1",
      mirrorCursor: null,
    },
  ],
  ...overrides,
});

const turn = (overrides: Partial<AdapterWorkTurn> = {}): AdapterWorkTurn => ({
  id: "t1",
  status: "running",
  source: "slack",
  userId: "u1",
  message: "do the thing",
  error: null,
  errorCode: null,
  createdAt: "2026-08-06T10:00:00.000Z",
  finishedAt: null,
  ...overrides,
});

const workItem = (
  turnOverrides: Partial<AdapterWorkTurn> = {},
): AdapterWorkItem => ({
  linkId: "l1",
  presenceId: "p1",
  conversationId: "cv1",
  externalThreadId: "D100",
  kind: "direct",
  turn: turn(turnOverrides),
});

/** A control plane whose config feed serves each entry once, then 304s. */
const feedControlPlane = (
  first: AdapterPresence[],
  overrides: Partial<ControlPlaneClient> = {},
) => {
  const feeds: AdapterConfigResponse[] = [{ presences: first, etag: "e1" }];
  const controlPlane = createFakeControlPlane({
    getConfig: async () => feeds.shift() ?? null,
    ...overrides,
  });
  return {
    controlPlane,
    pushFeed: (presences: AdapterPresence[], etag: string) =>
      feeds.push({ presences, etag }),
  };
};

const startAdapter = async (
  controlPlane: ControlPlaneClient,
): Promise<void> => {
  const adapter = createAdapter({
    config: adapterConfig(),
    controlPlane,
    log: () => {},
  });
  adapters.push(adapter);
  await adapter.start();
};

const eventsEnvelope = (eventId: string): string =>
  JSON.stringify({
    envelope_id: `env-${eventId}`,
    type: "events_api",
    payload: { event_id: eventId, event: { type: "message", text: "hi" } },
  });

describe("the config feed owns connections", () => {
  it("opens a socket for a socket presence, with the presence's app token", async () => {
    const { controlPlane } = feedControlPlane([presence()]);
    await startAdapter(controlPlane);

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    // The dial went through apps.connections.open with the APP token…
    const opens = slack.callsTo("apps.connections.open");
    expect(opens[0]?.token).toBe("xapp-app");
    // …and the socket was built from the URL Slack answered.
    expect(sockets[0]?.url).toBe("wss://fake.slack/link");
  });

  it("closes the socket when the presence disappears from the feed", async () => {
    const { controlPlane, pushFeed } = feedControlPlane([presence()]);
    await startAdapter(controlPlane);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();

    pushFeed([], "e2"); // the presence was detached

    await vi.waitFor(() => expect(sockets[0]!.closedByClient).toBe(true));
  });
});

describe("ownership acquisition drives unsettled-prompt recovery", () => {
  it("recovers on the boot feed and again on a NEW presence — never on a no-addition round", async () => {
    // Recovery rides applyConfig's `acquired` flag, not start(): the first
    // feed is all-adds (boot), and a later feed ADDING a presence is a dead
    // peer's slice failing over to us — both must re-arm the ledger's
    // unsettled cards, or a dead claimer's cards strand until some instance
    // restarts. A round that adds nothing (the same presences again, or a
    // removal) must NOT re-sweep. MUTATION-PROOF: delete the `acquired` flag
    // and its recovery block in applyConfig and no sweep ever fires — the
    // boot and failover waits below both time out.
    let recoveries = 0;
    let served = 0;
    const feeds: AdapterConfigResponse[] = [
      { presences: [presence()], etag: "e1" },
    ];
    const controlPlane = createFakeControlPlane({
      getConfig: async () => {
        const next = feeds.shift() ?? null;
        if (next) served += 1;
        return next;
      },
      listUnsettledPrompts: async () => {
        recoveries += 1;
        return [];
      },
    });
    await startAdapter(controlPlane);

    // (i) Boot: the first feed is all-adds — one recovery sweep.
    await vi.waitFor(() => expect(served).toBe(1));
    await vi.waitFor(() => expect(recoveries).toBe(1));

    // The same presence again: nothing acquired, no sweep.
    feeds.push({ presences: [presence()], etag: "e2" });
    await vi.waitFor(() => expect(served).toBe(2));
    await settle();
    expect(recoveries).toBe(1);

    // (ii) A NEW presence joins the feed (a failover slice) — sweep again.
    feeds.push({
      presences: [
        presence(),
        presence({ presenceId: "p2", transport: "events", links: [] }),
      ],
      etag: "e3",
    });
    await vi.waitFor(() => expect(served).toBe(3));
    await vi.waitFor(() => expect(recoveries).toBe(2));

    // (iii) Removal-only round: p2 detaches — still no sweep.
    feeds.push({ presences: [presence()], etag: "e4" });
    await vi.waitFor(() => expect(served).toBe(4));
    await settle();
    expect(recoveries).toBe(2);
  });
});

describe("ingest outcomes answer on the provider side", () => {
  const driveEvent = async (
    outcomes: AdapterIngestResponse[],
    presenceRow: AdapterPresence = presence(),
  ): Promise<AdapterIngestRequest[]> => {
    const ingests: AdapterIngestRequest[] = [];
    const queue = [...outcomes];
    const { controlPlane } = feedControlPlane([presenceRow], {
      ingest: async (request) => {
        ingests.push(request);
        return queue.shift() ?? { kind: "duplicate" };
      },
    });
    await startAdapter(controlPlane);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    for (let i = 0; i < outcomes.length; i += 1) {
      sockets[0]!.emit(eventsEnvelope(`Ev${i + 1}`));
    }
    return ingests;
  };

  it("posts a refusal to the reply target, escaped", async () => {
    const ingests = await driveEvent([
      {
        kind: "refused",
        message: "You are not a member of this workspace <sorry>",
        reply: { channel: "D100", threadTs: null },
      },
    ]);

    await vi.waitFor(() =>
      expect(slack.callsTo("chat.postMessage")).toHaveLength(1),
    );
    // The raw event went through the door with its dedupe id.
    expect(ingests[0]).toEqual({
      presenceId: "p1",
      eventId: "Ev1",
      event: { type: "message", text: "hi" },
    });
    const post = slack.callsTo("chat.postMessage")[0]!;
    expect(post.form.text).toBe(
      "You are not a member of this workspace &lt;sorry&gt;",
    );
    expect(post.form.channel).toBe("D100");
    expect("thread_ts" in post.form).toBe(false);
    // No avatar on this presence — no icon_url key at all, not an empty one.
    expect("icon_url" in post.form).toBe(false);
  });

  it("carries the agent's avatar as icon_url on a reply when the feed serves one", async () => {
    await driveEvent(
      [
        {
          kind: "refused",
          message: "Not a member",
          reply: { channel: "D100", threadTs: null },
        },
      ],
      presence({
        agent: {
          id: "ag1",
          name: "Deploy Agent",
          workspaceId: "proj1",
          imageUrl: "https://api.example.com/v1/agent-images/ag1/abc",
        },
      }),
    );
    await vi.waitFor(() =>
      expect(slack.callsTo("chat.postMessage")).toHaveLength(1),
    );
    expect(slack.callsTo("chat.postMessage")[0]!.form.icon_url).toBe(
      "https://api.example.com/v1/agent-images/ag1/abc",
    );
  });

  it("posts the busy line into the thread the message came from", async () => {
    await driveEvent([
      {
        kind: "busy",
        conversationId: "cv1",
        reply: { channel: "C5", threadTs: "171.5" },
      },
    ]);

    await vi.waitFor(() =>
      expect(slack.callsTo("chat.postMessage")).toHaveLength(1),
    );
    const post = slack.callsTo("chat.postMessage")[0]!;
    expect(post.form.text).toBe(
      "Still working on the last message. I'll take this one next.",
    );
    expect(post.form.channel).toBe("C5");
    expect(post.form.thread_ts).toBe("171.5");
  });

  it("posts NOTHING for turn outcomes — door failures included (the completion pass owns every answer)", async () => {
    // A door-failed turn is a FINISHED turn: the completion pass posts its
    // `turn.error` once. MUTATION-PROOF: re-add an immediate error reply in
    // respondToOutcome's turn arm and this asserts the double-delivery.
    await driveEvent([
      {
        kind: "turn",
        conversationId: "cv1",
        turn: turn(),
        reply: { channel: "D100", threadTs: null },
      },
      {
        kind: "turn",
        conversationId: "cv1",
        turn: turn({
          id: "t2",
          status: "failed",
          errorCode: "no_model_key",
          error: "No model key is configured for this agent.",
        }),
        reply: { channel: "D100", threadTs: null },
      },
    ]);

    await settle();
    expect(slack.callsTo("chat.postMessage")).toEqual([]);
  });

  it("refuses an invite by posting the refusal and STAYING — no leave call exists", async () => {
    // Refuse-and-stay-muted: leaving would need channels:manage/groups:write,
    // scopes the manifest deliberately never requests — so the adapter's whole
    // provider-side response is the refusal post. The Slack client no longer
    // even has a conversationsLeave method; the empty call list is the proof
    // nothing tried to leave.
    await driveEvent([
      {
        kind: "invite",
        outcome: "refuse",
        leave: false,
        message: "Only workspace members can invite me.",
        channel: "C9",
      },
    ]);

    await vi.waitFor(() =>
      expect(slack.callsTo("chat.postMessage")).toHaveLength(1),
    );
    expect(slack.callsTo("chat.postMessage")[0]?.form).toMatchObject({
      channel: "C9",
      text: "Only workspace members can invite me.",
    });
    await settle();
    expect(slack.callsTo("conversations.leave")).toEqual([]);
  });

  it("LOGS — and still never leaves — when a wire outcome carries leave:true", async () => {
    // The wire's `leave` field survives for a provider whose exit costs
    // nothing. For Slack no exit is implemented at all, so a leave:true
    // outcome (an older control plane, or a future provider's door) must
    // degrade to a log line — never a provider call.
    const logs: string[] = [];
    const { controlPlane } = feedControlPlane([presence()], {
      ingest: async () => ({
        kind: "invite",
        outcome: "refuse",
        leave: true,
        message: "Only workspace members can invite me.",
        channel: "C9",
      }),
    });
    const adapter = createAdapter({
      config: adapterConfig(),
      controlPlane,
      log: (message) => logs.push(message),
    });
    adapters.push(adapter);
    await adapter.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    sockets[0]!.emit(eventsEnvelope("Ev1"));

    await vi.waitFor(() =>
      expect(slack.callsTo("chat.postMessage")).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(logs).toContain(
        "leave requested but no provider exit is implemented",
      ),
    );
    await settle();
    expect(slack.callsTo("conversations.leave")).toEqual([]);
  });
});

describe("the completion pass posts once", () => {
  it("posts a finished provider turn's answer exactly once and claims the cursor WITH the turn id", async () => {
    // Nothing posts while the turn is unfinished (there is no live
    // rendering); the finished item drives ONE post, and the CAS claim
    // carries the turn id so the control plane can clear the reaction
    // receipt on the winning side.
    const advances: {
      linkId: string;
      expect: string | null;
      next: string;
      turnId: string | undefined;
    }[] = [];
    let phase: "running" | "finished" | "done" = "running";
    const { controlPlane } = feedControlPlane([presence()], {
      getWork: async () =>
        phase === "finished"
          ? {
              finished: [
                workItem({
                  status: "done",
                  finishedAt: "2026-08-06T10:00:05.000Z",
                }),
              ],
            }
          : { finished: [] },
      readTranscript: async () => ({
        events: [
          {
            seq: 1,
            turnId: "t1",
            type: "text",
            payload: { text: "the whole answer" },
          },
        ],
        nextSince: 1,
        hasMore: false,
      }),
      advanceCursor: async (linkId, expect_, next, turnId) => {
        advances.push({ linkId, expect: expect_, next, turnId });
        phase = "done";
        return true;
      },
    });
    await startAdapter(controlPlane);

    // A few empty polls first: no Slack traffic while the turn runs.
    await settle();
    expect(slack.callsTo("chat.postMessage")).toEqual([]);

    phase = "finished";
    await vi.waitFor(() =>
      expect(slack.callsTo("chat.postMessage")).toHaveLength(1),
    );
    await settle();

    // Exactly one post (provider-sourced ⇒ answer only, no question echo)…
    const posts = slack.callsTo("chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.form.text).toBe("the whole answer");
    expect(posts[0]?.form.channel).toBe("D100");
    // …and the claim carried the turn id for the receipt clear.
    expect(advances).toEqual([
      {
        linkId: "l1",
        expect: null,
        next: "2026-08-06T10:00:00.000Z",
        turnId: "t1",
      },
    ]);
  });

  it("posts NOTHING when the CAS is lost, and drops the local cursor for re-seed", async () => {
    // Claim-then-post: a lost CAS means a twin owns this turn — posting
    // anyway would double-deliver the answer. MUTATION-PROOF both ways:
    // (a) post-before-claim shows up as a post here; (b) turning the local
    // `cursors.delete` on loss into a set/no-op breaks the second claim's
    // null expectation below.
    const advances: { expect: string | null; next: string }[] = [];
    let phase: "t1" | "t2" | "done" = "t1";
    const seededLink = { ...presence().links[0]!, mirrorCursor: "SEED_A" };
    const { controlPlane } = feedControlPlane(
      [presence({ links: [seededLink] })],
      {
        getWork: async () =>
          phase === "t1"
            ? {
                finished: [
                  workItem({ id: "t1", status: "done", createdAt: "T1_TIME" }),
                ],
              }
            : phase === "t2"
              ? {
                  finished: [
                    workItem({
                      id: "t2",
                      status: "done",
                      createdAt: "T2_TIME",
                    }),
                  ],
                }
              : { finished: [] },
        readTranscript: async () => ({
          events: [
            {
              seq: 1,
              turnId: "t2",
              type: "text",
              payload: { text: "t2 answer" },
            },
          ],
          nextSince: 1,
          hasMore: false,
        }),
        advanceCursor: async (_linkId, expect_, next) => {
          advances.push({ expect: expect_, next });
          if (next === "T1_TIME") {
            phase = "t2";
            return false; // t1 LOSES — a twin advanced it
          }
          phase = "done";
          return true;
        },
      },
    );
    await startAdapter(controlPlane);

    await vi.waitFor(() => expect(advances).toHaveLength(2), {
      timeout: 5_000,
    });
    await vi.waitFor(() =>
      expect(slack.callsTo("chat.postMessage")).toHaveLength(1),
    );
    await settle();

    // t1 lost → nothing posted for it; only t2's answer went out.
    expect(slack.callsTo("chat.postMessage")).toHaveLength(1);
    // The lost claim used the seeded cursor; the next claim re-seeds to null
    // (the local entry was DROPPED, not adopted).
    expect(advances).toEqual([
      { expect: "SEED_A", next: "T1_TIME" },
      { expect: null, next: "T2_TIME" },
    ]);
  });

  it("re-seeds a lost link's NEXT claim from the item's server-supplied cursor floor", async () => {
    // An instance-identity etag no longer folds cursors, so after a CAS loss
    // drops the local entry the config feed cannot re-seed it — the work
    // item's `linkMirrorCursor` (ISO on the wire; opaque markers here) is the
    // fallback floor. Claiming with null against the DB's non-null cursor
    // would CAS-fail forever. The local cache still wins while it exists: the
    // FIRST claim below expects the seed, not the floor riding the same item.
    // MUTATION-PROOF: delete the `?? item.linkMirrorCursor` fallback in
    // handleFinished and the second claim's expectation collapses to null.
    const advances: { expect: string | null; next: string }[] = [];
    let phase: "t1" | "t2" | "done" = "t1";
    const seededLink = { ...presence().links[0]!, mirrorCursor: "SEED_A" };
    const { controlPlane } = feedControlPlane(
      [presence({ links: [seededLink] })],
      {
        getWork: async () =>
          phase === "t1"
            ? {
                finished: [
                  {
                    ...workItem({
                      id: "t1",
                      status: "done",
                      createdAt: "T1_TIME",
                    }),
                    linkMirrorCursor: "FLOOR_B",
                  },
                ],
              }
            : phase === "t2"
              ? {
                  finished: [
                    {
                      ...workItem({
                        id: "t2",
                        status: "done",
                        createdAt: "T2_TIME",
                      }),
                      linkMirrorCursor: "FLOOR_B",
                    },
                  ],
                }
              : { finished: [] },
        readTranscript: async () => ({
          events: [
            {
              seq: 1,
              turnId: "t2",
              type: "text",
              payload: { text: "t2 answer" },
            },
          ],
          nextSince: 1,
          hasMore: false,
        }),
        advanceCursor: async (_linkId, expect_, next) => {
          advances.push({ expect: expect_, next });
          if (next === "T1_TIME") {
            phase = "t2";
            return false; // t1 LOSES — the local cursor entry is dropped
          }
          phase = "done";
          return true;
        },
      },
    );
    await startAdapter(controlPlane);

    await vi.waitFor(() => expect(advances).toHaveLength(2), {
      timeout: 5_000,
    });

    // Local cache first while it exists; the server-supplied floor — never
    // null — once the loss dropped it.
    expect(advances).toEqual([
      { expect: "SEED_A", next: "T1_TIME" },
      { expect: "FLOOR_B", next: "T2_TIME" },
    ]);
  });
});

describe("the socket pump: ingest with bounded retry (finding G)", () => {
  it("retries a transient ingest failure so the message is not dropped", async () => {
    // The Slack envelope is already acked (the 3s rule), so Slack will NOT
    // redeliver — a dropped ingest is a lost user message. ingestWithRetry
    // re-attempts with backoff; ingest is idempotent by eventId.
    // MUTATION-PROOF: revert onEvent to a single-shot ingest and this transient
    // failure never gets processed — no reply ever posts.
    let attempts = 0;
    const { controlPlane } = feedControlPlane([presence()], {
      ingest: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient control-plane blip");
        return {
          kind: "refused",
          message: "no dice",
          reply: { channel: "D100", threadTs: null },
        };
      },
    });
    await startAdapter(controlPlane);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    sockets[0]!.emit(eventsEnvelope("Ev1"));

    // The retry (first backoff is 500ms) lands the second attempt, whose
    // outcome finally posts.
    await vi.waitFor(
      () => expect(slack.callsTo("chat.postMessage")).toHaveLength(1),
      { timeout: 3_000 },
    );
    expect(attempts).toBe(2);
    expect(slack.callsTo("chat.postMessage")[0]?.form.text).toBe("no dice");
  });

  it("logs after exhausting retries and does not crash on a persistent failure", async () => {
    // Fake only the timer families so the exponential backoff (500→4000ms)
    // advances by hand; setImmediate stays real so HTTP and waitReal keep
    // flowing (the approvals-test pattern).
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const logs: string[] = [];
    let attempts = 0;
    const { controlPlane } = feedControlPlane([presence()], {
      ingest: async () => {
        attempts += 1;
        throw new Error("control plane down");
      },
    });
    const adapter = createAdapter({
      config: adapterConfig(),
      controlPlane,
      log: (message) => logs.push(message),
    });
    adapters.push(adapter);
    await adapter.start();
    await waitReal(() => sockets.length === 1, "socket opened");
    sockets[0]!.open();
    sockets[0]!.emit(eventsEnvelope("Ev1"));

    await waitReal(() => attempts >= 1, "first ingest attempt");
    // Drive the five attempts (backoffs sum to 7.5s) through fake time.
    for (
      let i = 0;
      i < 8 && !logs.includes("ingest failed after retries");
      i += 1
    ) {
      await vi.advanceTimersByTimeAsync(8_000);
    }
    expect(attempts).toBe(5); // 1 initial + 4 retries, then it gives up
    expect(logs).toContain("ingest failed after retries");
    expect(slack.callsTo("chat.postMessage")).toEqual([]); // nothing posted
  });
});

describe("the rotation loop (proactive credential sweep)", () => {
  it("sweeps at boot and hourly through the control plane, logging only a non-zero result", async () => {
    // Fake only the timer families so the hourly cadence advances by hand;
    // the config/work poll intervals are stretched past the sweep so the
    // one-hour advance fires ONLY the rotation sleep (the retry test's
    // fake-timer pattern). Staleness itself is decided server-side — all the
    // loop owes is the call, the cadence, and the log.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const results = [
      { rotated: 0, failed: 0 },
      { rotated: 2, failed: 1 },
    ];
    let sweeps = 0;
    const logs: [string, unknown][] = [];
    const { controlPlane } = feedControlPlane([], {
      rotateIntegrations: async () => {
        sweeps += 1;
        return results.shift() ?? { rotated: 0, failed: 0 };
      },
    });
    const adapter = createAdapter({
      config: {
        ...adapterConfig(),
        configPollMs: 86_400_000,
        workPollMs: 86_400_000,
      },
      controlPlane,
      log: (message, detail) => logs.push([message, detail]),
    });
    adapters.push(adapter);
    await adapter.start();

    // The first sweep runs at boot, before any timer fires; its all-zero
    // result stays out of the log (idle installs must not chatter hourly).
    await waitReal(() => sweeps >= 1, "boot sweep");
    await settle();
    expect(sweeps).toBe(1);
    expect(logs.filter(([m]) => m === "integration credential sweep")).toEqual(
      [],
    );

    // One hour later the loop sweeps again; the non-zero result IS logged
    // with its counts — the operator's only trace that rotation happened.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await waitReal(() => sweeps >= 2, "hourly sweep");
    expect(sweeps).toBe(2);
    await waitReal(
      () => logs.some(([m]) => m === "integration credential sweep"),
      "sweep logged",
    );
    expect(logs.filter(([m]) => m === "integration credential sweep")).toEqual([
      ["integration credential sweep", { rotated: 2, failed: 1 }],
    ]);
  });
});

describe("interactive decisions", () => {
  const clickEnvelope = (
    actionId: string,
    value: string,
    clicker: string,
  ): string =>
    JSON.stringify({
      envelope_id: "env-click",
      type: "interactive",
      payload: {
        type: "block_actions",
        user: { id: clicker },
        actions: [{ action_id: actionId, value }],
      },
    });

  it("forwards the clicker and the opaque approval id, then settles the card", async () => {
    // Full circle: gateway offers an approval → card posted (claimed) →
    // a human clicks → the control plane decides (IT authorizes the
    // clicker; the id is all the click carries) → the card is rewritten.
    const decides: AdapterDecisionRequest[] = [];
    const { controlPlane } = feedControlPlane(
      [presence({ approvalsKey: "svc-key-1" })],
      {
        decide: async (request) => {
          decides.push(request);
          return { kind: "decided", decidedByName: "Dana <D>" };
        },
      },
    );
    gateway.script.push({
      status: 200,
      body: {
        requests: [
          {
            id: "app-1",
            method: "POST",
            host: "api.example.com",
            path: "/v1/emails",
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
          },
        ],
      },
    });
    await startAdapter(controlPlane);

    await vi.waitFor(() =>
      expect(slack.callsTo("chat.postMessage")).toHaveLength(1),
    );
    const card = slack.callsTo("chat.postMessage")[0]!;
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();

    sockets[0]!.emit(clickEnvelope("channel_approve", "app-1", "U77"));

    await vi.waitFor(() => expect(decides).toHaveLength(1));
    expect(decides[0]).toEqual({
      presenceId: "p1",
      approvalId: "app-1",
      decision: "approve",
      clickerExternalUserId: "U77",
    });
    await vi.waitFor(() =>
      expect(slack.callsTo("chat.update")).toHaveLength(1),
    );
    const update = slack.callsTo("chat.update")[0]!;
    expect(update.form.ts).toBe(card.response.ts);
    expect(update.form.text).toBe("✅ Approved by Dana &lt;D&gt;");
  });

  it("ignores interactive payloads that are not our approval buttons", async () => {
    const decides: AdapterDecisionRequest[] = [];
    const { controlPlane } = feedControlPlane([presence()], {
      decide: async (request) => {
        decides.push(request);
        return { kind: "already_settled" };
      },
    });
    await startAdapter(controlPlane);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();

    // A different block_actions surface, then a real click as the anchor.
    sockets[0]!.emit(
      JSON.stringify({
        envelope_id: "env-x",
        type: "interactive",
        payload: {
          type: "block_actions",
          user: { id: "U1" },
          actions: [{ action_id: "some_other_button", value: "zzz" }],
        },
      }),
    );
    sockets[0]!.emit(clickEnvelope("channel_deny", "app-2", "U2"));

    await vi.waitFor(() => expect(decides).toHaveLength(1));
    expect(decides[0]).toMatchObject({ approvalId: "app-2", decision: "deny" });
  });
});
