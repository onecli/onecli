import type { RunnerEvent } from "@onecli/agent-protocol";
import { expect } from "vitest";
import { scenario, type Cx } from "../src/scenario.js";
import { containerNameFor, isRunning } from "../src/docker.js";
import {
  containerOf,
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { bash, fakeDirective, sleep, text } from "../src/fake-dsl.js";
import type { TestBalancer } from "../src/balancer.js";
import type { TestRunnerHandle } from "../src/runner.js";
import {
  fetchTranscript,
  readTurn,
  runTurn,
  transcriptText,
  waitFor,
} from "../src/v1.js";
import type { V1Client } from "../src/v1.js";

/**
 * The runner as SEVERAL COPIES behind one address, against real containers.
 *
 * Two in-process copies on one token (one Runner row, two replicas) sit
 * behind a test balancer, the production shape: every sandbox dials the
 * balancer, whichever copy its flow lands on holds its socket, and the
 * control plane routes socket work (turns, aborts) to that copy and
 * lifecycle work (start, stop) to whichever copy claims it. Nothing a copy
 * remembers is needed by the other.
 */

const KEY = "k1.hosted-e2e-session-key-aaaaaaaaaaaaaaaaaaaaaaaa";
/** A fleet key that verifies none of KEY's sessions. */
const OTHER_KEY = "k9.hosted-e2e-session-key-zzzzzzzzzzzzzzzzzzzzzzzz";

interface Fleet {
  a: TestRunnerHandle;
  b: TestRunnerHandle;
  balancer: TestBalancer;
  v1: V1Client;
  /** The control plane, for posting as a runner directly. */
  apiOrigin: string;
  conversationId: string;
}

/**
 * Copies A and B behind one balancer, sessions on, the agent seeded. A
 * starts first, so A is the older copy: the reconciler.
 */
const fleet = async (
  cx: Cx,
  opts: { inheritedResumeGraceMs?: number } = {},
): Promise<Fleet> => {
  const stack = await cx.startStack({ withRunner: false });
  const balancer = await cx.startBalancer();
  const copy = () =>
    cx.startCopy({
      controlPlaneUrl: stack.api.origin,
      sessionKey: KEY,
      advertisedPort: balancer.port,
      ...(opts.inheritedResumeGraceMs !== undefined && {
        inheritedResumeGraceMs: opts.inheritedResumeGraceMs,
      }),
    });
  const a = await copy();
  const b = await copy();
  expect(b.runnerId).toBe(a.runnerId);
  balancer.add(a.wsPort);
  balancer.add(b.wsPort);
  await seedTenant(cx.prisma, cx.ids);
  await seedHostedAgent(cx.prisma, cx.ids, { runnerId: a.runnerId });
  await seedAnthropicGrant(cx.prisma, cx.ids);
  const conversation = await stack.v1.json<{ id: string }>(
    await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
  );
  return {
    a,
    b,
    balancer,
    v1: stack.v1,
    apiOrigin: stack.api.origin,
    conversationId: conversation.id,
  };
};

/** The copy (replica id) holding the sandbox's socket, and its owner. */
const channelRow = (cx: Cx) =>
  cx.prisma.sandbox.findUniqueOrThrow({
    where: { id: cx.ids.sandbox },
    select: {
      channelReplicaId: true,
      channelConnectionId: true,
      ownerReplicaId: true,
      status: true,
    },
  });

/** A copy's replica id, by the name it registered under. */
const replicaOf = async (cx: Cx, copy: TestRunnerHandle) =>
  (
    await cx.prisma.runnerReplica.findFirstOrThrow({
      where: { runnerId: copy.runnerId, name: copy.replicaName },
      select: { id: true },
    })
  ).id;

/** Force a copy's heartbeat outside the liveness window: what a dead copy
 * looks like once the window has passed, without waiting it out. */
const expire = async (cx: Cx, copy: TestRunnerHandle) => {
  await cx.prisma.runnerReplica.update({
    where: { id: await replicaOf(cx, copy) },
    data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) },
  });
};

const statusReports = (copy: TestRunnerHandle, status: string) =>
  copy.posted.filter(
    (e): e is Extract<RunnerEvent, { kind: "sandbox.status" }> =>
      e.kind === "sandbox.status" && e.status === status,
  );

/**
 * A turn long enough to move its socket in the middle of it: narration,
 * a long-running tool, more narration. The tool's start lands in the
 * transcript the moment it begins (narration only lands at the turn's end:
 * the answer law), so `midTurn` can see the turn is under way.
 */
const longTurn = (label: string, toolMs = 6_000) =>
  fakeDirective(
    [
      text(`${label}: part one`),
      bash(toolMs),
      text(`${label}: part two`),
      sleep(1_000),
      text(`${label}: part three`),
    ],
    label,
  );

/** Wait until the turn's long tool has started: the turn is mid-flight. */
const midTurn = (v1: V1Client, conversationId: string, turnId: string) =>
  waitFor(
    () => fetchTranscript(v1, conversationId),
    (events) =>
      events.some((e) => e.turnId === turnId && e.type === "tool.started"),
    "the turn's long tool to start",
    30_000,
  );

const postTurn = async (
  v1: V1Client,
  conversationId: string,
  message: string,
) =>
  (
    await v1.json<{ id: string }>(
      await v1.post(`/v1/conversations/${conversationId}/turns`, { message }),
    )
  ).id;

const settle = (v1: V1Client, conversationId: string, turnId: string) =>
  waitFor(
    () => readTurn(v1, conversationId, turnId),
    (turn) =>
      turn !== null && ["done", "failed", "aborted"].includes(turn.status),
    `turn ${turnId} to settle`,
    90_000,
  );

const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

scenario(
  "a start on copy A whose supervisor lands on copy B: B serves every turn, A never gets the socket work",
  async (cx) => {
    const f = await fleet(cx);
    const replicaA = await replicaOf(cx, f.a);
    const replicaB = await replicaOf(cx, f.b);
    // Only A polls, so A claims the start (and owns the lifecycle); the
    // balancer sends the supervisor's flow to B.
    f.balancer.pin(f.b.wsPort);
    f.a.pump();
    await waitFor(
      () => channelRow(cx),
      (row) => row.channelConnectionId !== null,
      "the supervisor to connect",
    );
    const booted = await channelRow(cx);
    expect(booted.ownerReplicaId).toBe(replicaA);
    expect(booted.channelReplicaId).toBe(replicaB);
    expect(f.b.hasConnection(cx.ids.sandbox)).toBe(true);
    expect(f.a.hasConnection(cx.ids.sandbox)).toBe(false);

    // Both copies poll from here on: every turn still reaches B, because
    // the control plane hands socket work only to the copy holding it.
    f.b.pump();
    for (const message of ["one", "two", "three"]) {
      expect((await runTurn(f.v1, f.conversationId, message)).status).toBe(
        "done",
      );
    }
    // A never had a turn to give back: not one agent_restarted from it.
    expect(f.a.posted.filter((e) => e.kind === "turn.finished")).toEqual([]);
    expect(statusReports(f.a, "stopped")).toEqual([]);
    expect(statusReports(f.b, "stopped")).toEqual([]);
  },
);

scenario(
  "copy B CRASHES mid-turn: the supervisor moves to A with its session, the turn finishes `done`, nothing is recreated",
  async (cx) => {
    const f = await fleet(cx);
    const replicaA = await replicaOf(cx, f.a);
    f.balancer.pin(f.b.wsPort);
    f.a.pump();
    f.b.pump();
    expect((await runTurn(f.v1, f.conversationId, "warm up")).status).toBe(
      "done",
    );
    expect(f.b.hasConnection(cx.ids.sandbox)).toBe(true);
    const containerBefore = await containerOf(cx.prisma, cx.ids.sandbox);

    const turnId = await postTurn(f.v1, f.conversationId, longTurn("move"));
    await midTurn(f.v1, f.conversationId, turnId);
    // THE CRASH: B's sockets die at the TCP level, nothing drained. The
    // balancer takes B out of rotation on its next probe, so the
    // supervisor's redial lands on A.
    f.balancer.pin(undefined);
    await f.b.crash();

    await waitFor(
      () => channelRow(cx),
      (row) =>
        row.channelReplicaId === replicaA && row.channelConnectionId !== null,
      "the supervisor to reattach to A",
    );
    // A message sent DURING the move joins the live turn once A holds the
    // socket (a follow-up in the same conversation).
    const during = await f.v1.json<{ turn: { id: string } }>(
      await f.v1.post(`/v1/conversations/${f.conversationId}/messages`, {
        message: "sent during the move",
      }),
    );
    expect((await settle(f.v1, f.conversationId, turnId))?.status).toBe("done");
    expect(
      (await readTurn(f.v1, f.conversationId, during.turn.id))?.status,
    ).toBe("joined");

    const transcript = transcriptText(
      await fetchTranscript(f.v1, f.conversationId),
    );
    for (const part of ["part two", "part three"]) {
      expect(count(transcript, `move: ${part}`)).toBe(1);
    }
    expect(await containerOf(cx.prisma, cx.ids.sandbox)).toBe(containerBefore);
    expect(statusReports(f.a, "stopped")).toEqual([]);
  },
);

scenario(
  "a graceful ROLL of the copy holding the socket: drained, retired, the turn in flight finishes on the other copy",
  async (cx) => {
    const f = await fleet(cx);
    const replicaA = await replicaOf(cx, f.a);
    f.balancer.pin(f.b.wsPort);
    f.a.pump();
    f.b.pump();
    expect((await runTurn(f.v1, f.conversationId, "warm up")).status).toBe(
      "done",
    );
    const containerBefore = await containerOf(cx.prisma, cx.ids.sandbox);

    // A long tool: the roll (retire, drain, close) must land inside the turn.
    const turnId = await postTurn(
      f.v1,
      f.conversationId,
      longTurn("roll", 15_000),
    );
    await midTurn(f.v1, f.conversationId, turnId);
    f.balancer.pin(undefined);
    // THE ROLL: B retires (handed nothing new from here on), drains (1012
    // to every supervisor, /healthz 503 so the balancer stops sending it
    // flows), closes.
    await f.b.stop();
    // Still in flight: the move happened under a live turn.
    expect((await readTurn(f.v1, f.conversationId, turnId))?.status).toBe(
      "running",
    );
    // B signed out for good: retired once, by the time its stop returns,
    // however many calls (final reports, socket releases) it made after.
    const replicaB = await cx.prisma.runnerReplica.findUniqueOrThrow({
      where: { id: await replicaOf(cx, f.b) },
      select: { retiredAt: true },
    });
    expect(replicaB.retiredAt).not.toBeNull();

    await waitFor(
      () => channelRow(cx),
      (row) =>
        row.channelReplicaId === replicaA && row.channelConnectionId !== null,
      "the supervisor to reattach to A",
    );
    expect((await settle(f.v1, f.conversationId, turnId))?.status).toBe("done");
    // The answer (what the agent said after its last tool) arrived exactly
    // once: nothing lost in the move, nothing replayed twice.
    const transcript = transcriptText(
      await fetchTranscript(f.v1, f.conversationId),
    );
    for (const part of ["part two", "part three"]) {
      expect(count(transcript, `roll: ${part}`)).toBe(1);
    }
    expect((await channelRow(cx)).status).toBe("running");
    expect(await containerOf(cx.prisma, cx.ids.sandbox)).toBe(containerBefore);
    expect(
      (await runTurn(f.v1, f.conversationId, "after the roll")).status,
    ).toBe("done");
  },
);

scenario(
  "only ONE copy reconciles; when it dies the other takes the role over",
  async (cx) => {
    // The sandbox under reconcile: a running container whose socket nobody
    // holds and whose supervisor never comes back. Its supervisor was told
    // no session (a keyless spawn), so the reconcilers have nothing to
    // wait for once the socket is gone.
    const stack = await cx.startStack({ withRunner: false });
    const keyless = await cx.startCopy({ controlPlaneUrl: stack.api.origin });
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, { runnerId: keyless.runnerId });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    keyless.pump();
    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    expect((await runTurn(stack.v1, conversation.id, "warm up")).status).toBe(
      "done",
    );
    const container = containerNameFor(cx.ids.sandbox);
    const containerBefore = await containerOf(cx.prisma, cx.ids.sandbox);
    await keyless.stop();

    // A and B, on another port (the container's supervisor dials the old
    // one forever): A is older, so A reconciles.
    const balancer = await cx.startBalancer();
    const copy = () =>
      cx.startCopy({
        controlPlaneUrl: stack.api.origin,
        sessionKey: KEY,
        advertisedPort: balancer.port,
      });
    const a = await copy();
    const b = await copy();
    // Both copies' start() ran a reconcile pass already; A's (the
    // reconciler's) found the stranded container and B's did nothing.
    expect(statusReports(b, "stopped")).toEqual([]);
    expect(statusReports(a, "stopped")).toEqual([
      expect.objectContaining({
        sandboxId: cx.ids.sandbox,
        observedContainerRef: containerBefore,
      }),
    ]);

    // A dies without retiring; once its heartbeat is outside the liveness
    // window (forced here) the role passes to B. The row was parked by A's
    // report, so B now finds the container a stray, and stops it.
    await a.crash();
    await expire(cx, a);
    await waitFor(
      async () => {
        await b.reconcile();
        await b.tick(0);
        return isRunning(container);
      },
      (running) => !running,
      "the new reconciler to stop the stray container",
    );
  },
);

scenario(
  "a container left with NO socket anywhere (every copy that held it gone): the reconciler reports it stopped and the next message wakes the sandbox",
  async (cx) => {
    // The sandbox runs under a copy that held its socket; then that copy
    // crashes and the only copy left cannot verify the supervisor's session
    // (a fleet key that does not match: the key-dropped shape). The
    // container runs on with no socket anywhere, so the reconciler is the
    // only party that can notice it.
    const stack = await cx.startStack({ withRunner: false });
    const balancer = await cx.startBalancer();
    const copy = (sessionKey: string) =>
      cx.startCopy({
        controlPlaneUrl: stack.api.origin,
        sessionKey,
        advertisedPort: balancer.port,
        inheritedResumeGraceMs: 2_000,
      });
    const a = await copy(OTHER_KEY);
    const b = await copy(KEY);
    balancer.add(a.wsPort);
    balancer.add(b.wsPort);
    balancer.pin(b.wsPort);
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, { runnerId: a.runnerId });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    b.pump();
    expect((await runTurn(stack.v1, conversation.id, "warm up")).status).toBe(
      "done",
    );
    const containerBefore = await containerOf(cx.prisma, cx.ids.sandbox);

    // B crashes; its identity is past the liveness window (forced here).
    // B's poll stops first: an in-process "crash" cannot kill a poll
    // already on the wire, and one that claimed the wake start for B after
    // the crash would leave it to the 5-minute stale-claim rule, a different
    // scenario.
    await b.pausePump();
    balancer.remove(b.wsPort);
    await b.crash();
    await expire(cx, b);

    // Past the inherited grace, A (the reconciler) reports it, stamped
    // with the container it found.
    await waitFor(
      async () => {
        await a.reconcile();
        return statusReports(a, "stopped");
      },
      (reports) => reports.length > 0,
      "the reconciler to report the sandbox stopped",
      30_000,
    );
    expect(statusReports(a, "stopped")[0]?.observedContainerRef).toBe(
      containerBefore,
    );
    expect(a.hasConnection(cx.ids.sandbox)).toBe(false);

    // The next message wakes it: a fresh container (a fresh token, which
    // any copy admits), served by A.
    a.pump();
    const after = await runTurn(stack.v1, conversation.id, "wake up");
    expect(after.status).toBe("done");
    expect(await containerOf(cx.prisma, cx.ids.sandbox)).not.toBe(
      containerBefore,
    );
  },
);

scenario(
  "a STALE observation (about a replaced container) never knocks down the fresh start",
  async (cx) => {
    const f = await fleet(cx);
    f.a.pump();
    f.b.pump();
    expect((await runTurn(f.v1, f.conversationId, "warm up")).status).toBe(
      "done",
    );
    const oldContainer = await containerOf(cx.prisma, cx.ids.sandbox);
    if (oldContainer === null) throw new Error("no container recorded");

    // An agent restart replaces the container.
    expect(
      (await f.v1.post(`/v1/agents/${cx.ids.agent}/restart`, {})).status,
    ).toBe(200);
    expect((await runTurn(f.v1, f.conversationId, "fresh")).status).toBe(
      "done",
    );
    const fresh = await containerOf(cx.prisma, cx.ids.sandbox);
    expect(fresh).not.toBe(oldContainer);

    // A late report about the OLD container (what a slow copy's reconcile
    // could still post) changes nothing.
    const response = await fetch(`${f.apiOrigin}/v1/runner/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cx.ids.runnerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        events: [
          {
            kind: "sandbox.status",
            sandboxId: cx.ids.sandbox,
            status: "stopped",
            observedContainerRef: oldContainer,
          },
        ],
      }),
    });
    expect(response.ok).toBe(true);
    const row = await channelRow(cx);
    expect(row.status).toBe("running");
    expect((await runTurn(f.v1, f.conversationId, "still here")).status).toBe(
      "done",
    );
  },
);
