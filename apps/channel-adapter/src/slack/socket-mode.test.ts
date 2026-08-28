import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openSocketMode,
  type SocketModeConnection,
  type SocketModeHandlers,
} from "./socket-mode";
import { FakeSocket } from "../test/fake-socket";
import { startFakeSlackServer, type FakeSlackServer } from "../test/fakes";

/**
 * One Socket Mode connection against a fake WebSocket (via socketFactory)
 * and a scripted `apps.connections.open` (via SLACK_API_BASE_URL — the
 * client reads it at call time). The laws under test are the ones Slack
 * punishes silently: ack within 3s or be redelivered-then-disconnected,
 * redial on the hourly refresh, and never retry a token Slack REFUSED.
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let slack: FakeSlackServer;
let connections: SocketModeConnection[];

beforeEach(async () => {
  slack = await startFakeSlackServer();
  process.env.SLACK_API_BASE_URL = slack.url;
  connections = [];
});

afterEach(async () => {
  for (const connection of connections) connection.close();
  delete process.env.SLACK_API_BASE_URL;
  await slack.close();
});

const setup = (overrides: Partial<SocketModeHandlers> = {}) => {
  const sockets: FakeSocket[] = [];
  const events: { event: unknown; eventId: string }[] = [];
  const interactives: Record<string, unknown>[] = [];
  const failures: string[] = [];
  const logs: string[] = [];
  const connection = openSocketMode(
    {
      appToken: "xapp-test",
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    },
    {
      onEvent: (input) => events.push(input),
      onInteractive: (payload) => interactives.push(payload),
      onPermanentFailure: (reason) => failures.push(reason),
      onLog: (message) => logs.push(message),
      ...overrides,
    },
  );
  connections.push(connection);
  return { connection, sockets, events, interactives, failures, logs };
};

const dialed = async (sockets: FakeSocket[], count: number): Promise<void> => {
  await vi.waitFor(() => expect(sockets.length).toBe(count), {
    timeout: 3_000,
  });
};

const eventsEnvelope = (
  envelopeId: string,
  eventId: string,
  event: unknown = { type: "message", text: "hi" },
): string =>
  JSON.stringify({
    envelope_id: envelopeId,
    type: "events_api",
    payload: { event_id: eventId, event },
  });

describe("the ack-first law", () => {
  it("acks every enveloped message BEFORE any handler side effect", async () => {
    // Slack's 3s rule: an ack that waits on our processing gets the envelope
    // redelivered and eventually the link dropped. MUTATION-PROOF: move the
    // ack below the events_api dispatch in socket-mode.ts and the recorded
    // order here flips to ["handler", "ack:env-1"].
    const order: string[] = [];
    const { sockets } = setup({ onEvent: () => order.push("handler") });
    await dialed(sockets, 1);
    const socket = sockets[0]!;
    socket.onSend = (raw) =>
      order.push(
        `ack:${(JSON.parse(raw) as { envelope_id?: string }).envelope_id}`,
      );

    socket.open();
    socket.emit(eventsEnvelope("env-1", "Ev1"));

    expect(order).toEqual(["ack:env-1", "handler"]);
  });

  it("acks with EXACTLY the envelope id payload", async () => {
    const { sockets } = setup();
    await dialed(sockets, 1);
    sockets[0]!.open();
    sockets[0]!.emit(eventsEnvelope("env-7", "Ev7"));

    expect(sockets[0]!.sent.map((raw) => JSON.parse(raw))).toEqual([
      { envelope_id: "env-7" },
    ]);
  });

  it("sends no ack for a hello frame (it carries no envelope id)", async () => {
    const { sockets, events } = setup();
    await dialed(sockets, 1);
    sockets[0]!.open();
    sockets[0]!.emit(JSON.stringify({ type: "hello", num_connections: 1 }));

    expect(sockets[0]!.sent).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("envelope routing", () => {
  it("hands an events_api envelope to onEvent with its event id", async () => {
    const { sockets, events } = setup();
    await dialed(sockets, 1);
    sockets[0]!.open();
    sockets[0]!.emit(
      eventsEnvelope("env-1", "Ev123", { type: "message", text: "hey" }),
    );

    expect(events).toEqual([
      { event: { type: "message", text: "hey" }, eventId: "Ev123" },
    ]);
  });

  it("drops an events_api envelope missing its event id (still acked)", async () => {
    // The control-plane dedupe is keyed on the event id; without one the
    // event cannot be ingested exactly-once, so it must not be ingested.
    const { sockets, events } = setup();
    await dialed(sockets, 1);
    sockets[0]!.open();
    sockets[0]!.emit(
      JSON.stringify({
        envelope_id: "env-2",
        type: "events_api",
        payload: { event: { type: "message" } },
      }),
    );

    expect(events).toEqual([]);
    expect(sockets[0]!.sent).toHaveLength(1);
  });

  it("hands an interactive envelope to onInteractive", async () => {
    const { sockets, interactives } = setup();
    await dialed(sockets, 1);
    sockets[0]!.open();
    const payload = {
      type: "block_actions",
      user: { id: "U1" },
      actions: [{ action_id: "channel_approve", value: "app-1" }],
    };
    sockets[0]!.emit(
      JSON.stringify({ envelope_id: "env-3", type: "interactive", payload }),
    );

    expect(interactives).toEqual([payload]);
  });

  it("ignores a non-JSON frame without dying", async () => {
    const { sockets, events } = setup();
    await dialed(sockets, 1);
    sockets[0]!.open();
    sockets[0]!.emit("}{ not json");
    sockets[0]!.emit(eventsEnvelope("env-4", "Ev4"));

    expect(events).toHaveLength(1);
  });
});

describe("the Slack refresh cycle", () => {
  it.each(["warning", "refresh_requested"])(
    "dials a fresh link immediately on a disconnect frame with reason %s",
    async (reason) => {
      const { sockets } = setup();
      await dialed(sockets, 1);
      sockets[0]!.open();

      sockets[0]!.emit(JSON.stringify({ type: "disconnect", reason }));

      await dialed(sockets, 2);
      // A NEW connections.open call — the old wss URL is single-use.
      expect(slack.callsTo("apps.connections.open")).toHaveLength(2);
    },
  );

  it("ignores the dying socket's later events from the disconnect frame onward", async () => {
    // The stale-socket guard, in the window that matters: the replacement
    // dial's connections.open round trip is still in flight, and Slack keeps
    // draining the dying link meanwhile. MUTATION-PROOF: delete the
    // `generation += 1` in the disconnect branch and the drained events get
    // handled off a socket that no longer speaks for us.
    const { sockets, events } = setup();
    await dialed(sockets, 1);
    sockets[0]!.open();
    sockets[0]!.emit(
      JSON.stringify({ type: "disconnect", reason: "refresh_requested" }),
    );

    // Still inside the redial window — no second socket exists yet.
    sockets[0]!.emit(eventsEnvelope("env-stale", "Ev-stale"));
    expect(events).toEqual([]);
    // Not even an ack: the stale socket no longer speaks for us at all.
    expect(sockets[0]!.sent).toEqual([]);

    // And still ignored once the replacement is up and working.
    await dialed(sockets, 2);
    sockets[0]!.emit(eventsEnvelope("env-stale-2", "Ev-stale-2"));
    sockets[1]!.open();
    sockets[1]!.emit(eventsEnvelope("env-new", "Ev-new"));
    expect(events).toEqual([
      { event: { type: "message", text: "hi" }, eventId: "Ev-new" },
    ]);
  });

  it("treats link_disabled as permanent: reports it and never redials", async () => {
    const { sockets, failures } = setup();
    await dialed(sockets, 1);
    sockets[0]!.open();

    sockets[0]!.emit(
      JSON.stringify({ type: "disconnect", reason: "link_disabled" }),
    );

    expect(failures).toEqual(["link_disabled"]);
    // Longer than the initial backoff: a scheduled redial would have fired.
    await sleep(650);
    expect(sockets).toHaveLength(1);
    expect(slack.callsTo("apps.connections.open")).toHaveLength(1);
  });
});

describe("dial failures", () => {
  it("schedules a reconnect on `error` with no `close` (the both-events law)", async () => {
    // A socket that never establishes may emit error and no close at all;
    // driving the retry solely from close would end the chain right there.
    const { sockets } = setup();
    await dialed(sockets, 1);
    sockets[0]!.open();

    sockets[0]!.errorOnly();

    await dialed(sockets, 2);
    expect(slack.callsTo("apps.connections.open")).toHaveLength(2);
  });

  it("treats an invalid_auth answer as permanent — no retry loop", async () => {
    // Slack ANSWERED and said no (the runner's register law): retrying the
    // same app token forever would hide the misconfiguration.
    slack.respond("apps.connections.open", () => ({
      ok: false,
      error: "invalid_auth",
    }));
    const { sockets, failures } = setup();

    await vi.waitFor(() => expect(failures).toEqual(["invalid_auth"]));
    await sleep(650);
    expect(slack.callsTo("apps.connections.open")).toHaveLength(1);
    expect(sockets).toHaveLength(0);
  });
});

describe("close", () => {
  it("cancels a pending redial — no dial after a deliberate close", async () => {
    const { connection, sockets } = setup();
    await dialed(sockets, 1);
    sockets[0]!.open();
    sockets[0]!.fail(); // schedules the redial

    connection.close();

    await sleep(650);
    expect(sockets).toHaveLength(1);
    expect(slack.callsTo("apps.connections.open")).toHaveLength(1);
  });

  it("closes the live socket and reports not open", async () => {
    const { connection, sockets } = setup();
    await dialed(sockets, 1);
    sockets[0]!.open();
    expect(connection.isOpen()).toBe(true);

    connection.close();

    expect(sockets[0]!.closedByClient).toBe(true);
    expect(connection.isOpen()).toBe(false);
    // A late error from the closed socket must not resurrect the dialer.
    sockets[0]!.errorOnly();
    await sleep(650);
    expect(sockets).toHaveLength(1);
  });
});

describe("backoff", () => {
  it("resets to the initial delay after a successful open", async () => {
    // MUTATION-PROOF: drop the `backoff = INITIAL_BACKOFF_MS` in the open
    // listener and the second reconnect log reads 1000ms — every hourly
    // refresh would then ratchet the daemon toward the 30s ceiling forever.
    const { sockets, logs } = setup();
    await dialed(sockets, 1);
    sockets[0]!.open();
    sockets[0]!.fail();
    await dialed(sockets, 2);

    sockets[1]!.open(); // the recovery that must reset the clock
    sockets[1]!.fail();
    await dialed(sockets, 3);

    expect(logs.filter((line) => line.startsWith("reconnecting"))).toEqual([
      "reconnecting in 500ms",
      "reconnecting in 500ms",
    ]);
  });
});
