import type { RunnerEvent } from "@onecli/agent-protocol";
import { expect } from "vitest";
import { scenario, type Cx } from "../src/scenario.js";
import { containerNameFor, dockerKill, dockerLogs } from "../src/docker.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, sleep, text } from "../src/fake-dsl.js";
import { startTestRunner, type TestRunnerHandle } from "../src/runner.js";
import {
  fetchTranscript,
  readTurn,
  runTurn,
  transcriptText,
  waitFor,
} from "../src/v1.js";
import type { V1Client } from "../src/v1.js";

/**
 * The resumable supervisor channel, end to end against real containers.
 *
 * Before this feature a runner restart (every deploy, any crash) severed every
 * supervisor's channel for good: the single-use bootstrap token died with the
 * process, reconcile reported the sandbox `stopped`, and a turn in flight was
 * failed even though the agent inside was fine. `hardening.test.ts` pins that
 * old posture ("a runner restart reconciles a stranded box back to life") for
 * a runner WITHOUT a session key. These scenarios run the same shape WITH the
 * key: the turn survives, the transcript is whole, and nothing is recreated.
 *
 * Each restart here is the production shape exactly: the runner process goes
 * away (its ws server with it), the container keeps running, and a NEW process
 * with the same registration token and the same fleet key takes over.
 */

const KEY = "k1.hosted-e2e-session-key-aaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_ROTATED = "k2.hosted-e2e-session-key-bbbbbbbbbbbbbbbbbbbbbbbb";

/** A turn long enough to restart the runner in the middle of it. */
const longTurn = (label: string) =>
  fakeDirective(
    [
      text(`${label}: part one`),
      sleep(3_000),
      text(`${label}: part two`),
      sleep(3_000),
      text(`${label}: part three`),
    ],
    label,
  );

/** Post a turn and return its id without waiting for it to settle. */
const postTurn = async (
  v1: V1Client,
  conversationId: string,
  message: string,
): Promise<string> =>
  (
    await v1.json<{ id: string }>(
      await v1.post(`/v1/conversations/${conversationId}/turns`, { message }),
    )
  ).id;

/** Wait until the turn has produced at least one event (it is mid-flight). */
/**
 * Drive reconcile until the runner has reported the sandbox `stopped`.
 * `docker kill` returns once the signal is SENT; the engine can still list
 * the container as running for a beat after, and a single reconcile in that
 * beat sees a running, in-grace box and (correctly) reports nothing. The
 * production cadence re-checks on its own; the suite pins reconcile to
 * 3600 s so a test drives it by hand, the way the hardening leg does.
 */
const reconcileUntilStopped = (runner: TestRunnerHandle, sandboxId: string) =>
  waitFor(
    async () => {
      await runner.reconcile();
      return runner.posted.some(
        (e) =>
          e.kind === "sandbox.status" &&
          e.sandboxId === sandboxId &&
          e.status === "stopped",
      );
    },
    (reported) => reported,
    `the runner to report ${sandboxId} stopped`,
  );

const waitForProgress = (
  v1: V1Client,
  conversationId: string,
  marker: string,
) =>
  waitFor(
    async () => transcriptText(await fetchTranscript(v1, conversationId)),
    (t) => t.includes(marker),
    `turn to reach "${marker}"`,
    30_000,
  );

const settle = (v1: V1Client, conversationId: string, turnId: string) =>
  waitFor(
    () => readTurn(v1, conversationId, turnId),
    (turn) =>
      turn !== null && ["done", "failed", "aborted"].includes(turn.status),
    `turn ${turnId} to settle`,
    90_000,
  );

/** Occurrences of a substring: the duplicate-event check. */
const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

/**
 * The core leg, run under both creation orders: Docker's (the runner records
 * the container ref before the supervisor can dial in) and the cloud
 * backend's (create returns only once the supervisor is connected, so the
 * session is handed LATE). The second order is the one that once handed no
 * session at all.
 */
const restartMidTurn = async (cx: Cx, createReturnsAfterConnect: boolean) => {
  const stack = await cx.startStack({ withRunner: false });
  const first = await startTestRunner({
    controlPlaneUrl: stack.api.origin,
    ids: cx.ids,
    config: cx.config,
    sessionKey: KEY,
    createReturnsAfterConnect,
  });
  await seedTenant(cx.prisma, cx.ids);
  await seedHostedAgent(cx.prisma, cx.ids, { runnerId: first.runnerId });
  await seedAnthropicGrant(cx.prisma, cx.ids);
  first.pump();

  const conversation = await stack.v1.json<{ id: string }>(
    await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
  );
  // A warm-up turn so the sandbox exists and holds a session.
  expect((await runTurn(stack.v1, conversation.id, "warm up")).status).toBe(
    "done",
  );
  const containerBefore = first.containerRefOf(cx.ids.sandbox);
  expect(containerBefore).toBeDefined();

  // The turn under test: restart the runner between part one and two.
  const turnId = await postTurn(stack.v1, conversation.id, longTurn("resume"));
  await waitForProgress(stack.v1, conversation.id, "resume: part one");

  // THE DEPLOY. Stop the loop and the ws server; the container stays.
  await first.stop();
  const second: TestRunnerHandle = await startTestRunner({
    controlPlaneUrl: stack.api.origin,
    ids: cx.ids,
    config: cx.config,
    wsPort: first.wsPort,
    sessionKey: KEY,
    createReturnsAfterConnect,
  });
  expect(second.runnerId).toBe(first.runnerId);
  // The new process's boot reconcile and an explicit one: neither may
  // report the inherited sandbox stopped. The supervisor is reconnecting
  // inside its grace, and a `stopped` here is exactly the old bug (the
  // control plane would fail the in-flight turn on it).
  await second.reconcile();
  expect(
    second.posted.filter(
      (e) => e.kind === "sandbox.status" && e.status === "stopped",
    ),
  ).toEqual([]);
  second.pump();

  const settled = await settle(stack.v1, conversation.id, turnId);
  expect(settled?.status).toBe("done");
  // Still none after the turn: the resume was clean end to end.
  expect(
    second.posted.filter(
      (e) => e.kind === "sandbox.status" && e.status === "stopped",
    ),
  ).toEqual([]);

  const transcript = transcriptText(
    await fetchTranscript(stack.v1, conversation.id),
  );
  // Every part arrived exactly once: the gap replayed, nothing duplicated.
  for (const part of ["part one", "part two", "part three"]) {
    expect(count(transcript, `resume: ${part}`)).toBe(1);
  }
  // Same container: the sandbox was never recreated.
  expect(second.containerRefOf(cx.ids.sandbox)).toBe(containerBefore);
  // The supervisor's own account: it was handed a session on the first
  // connect, dialled back in with it, and had it resumed by the NEW
  // process (this is the line that distinguishes a resume from a lucky
  // reconnect to the same process).
  const supervisorLog = await waitFor(
    () => dockerLogs(containerNameFor(cx.ids.sandbox)),
    (log) => log.includes('"runner session resumed"'),
    "the supervisor to log its resumed session",
    15_000,
  );
  expect(supervisorLog).toContain('"runner session held"');
  expect(supervisorLog).not.toContain("runner session refused");
  expect(supervisorLog).not.toContain("gave up reconnecting");

  // And the channel keeps working for the next turn.
  expect(
    (await runTurn(stack.v1, conversation.id, "after the restart")).status,
  ).toBe("done");

  await second.stop();
  await second.reap();
};

scenario(
  "a runner restart mid-turn: the turn finishes `done`, the transcript is whole, nothing is recreated",
  (cx) => restartMidTurn(cx, false),
);

scenario(
  "the same restart under the CLOUD creation order (the supervisor connects before the runner knows the container): the session is handed late and still resumes",
  (cx) => restartMidTurn(cx, true),
);

scenario(
  "a runner CRASH mid-turn (sockets torn down, nothing drained): the turn still finishes `done`",
  async (cx) => {
    // The deploy shape above closes sockets politely; a SIGKILL or an OOM
    // does not. The supervisor must notice the dead TCP flow on its own and
    // the replacement process must pick the session up exactly the same way.
    const stack = await cx.startStack({ withRunner: false });
    const first = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      sessionKey: KEY,
    });
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, { runnerId: first.runnerId });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    first.pump();
    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    expect((await runTurn(stack.v1, conversation.id, "warm up")).status).toBe(
      "done",
    );
    const containerBefore = first.containerRefOf(cx.ids.sandbox);

    const turnId = await postTurn(stack.v1, conversation.id, longTurn("crash"));
    await waitForProgress(stack.v1, conversation.id, "crash: part one");
    await first.crash();
    const second = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      wsPort: first.wsPort,
      sessionKey: KEY,
    });
    await second.reconcile();
    second.pump();

    expect((await settle(stack.v1, conversation.id, turnId))?.status).toBe(
      "done",
    );
    const transcript = transcriptText(
      await fetchTranscript(stack.v1, conversation.id),
    );
    for (const part of ["part one", "part two", "part three"]) {
      expect(count(transcript, `crash: ${part}`)).toBe(1);
    }
    expect(second.containerRefOf(cx.ids.sandbox)).toBe(containerBefore);
    expect(
      second.posted.filter(
        (e) => e.kind === "sandbox.status" && e.status === "stopped",
      ),
    ).toEqual([]);
    await second.stop();
    await second.reap();
  },
);

scenario(
  "the key rotates between the two processes (`new,old`): the session still resumes",
  async (cx) => {
    const stack = await cx.startStack({ withRunner: false });
    const first = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      sessionKey: KEY,
    });
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, { runnerId: first.runnerId });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    first.pump();
    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    expect((await runTurn(stack.v1, conversation.id, "warm up")).status).toBe(
      "done",
    );
    const containerBefore = first.containerRefOf(cx.ids.sandbox);

    const turnId = await postTurn(
      stack.v1,
      conversation.id,
      longTurn("rotate"),
    );
    await waitForProgress(stack.v1, conversation.id, "rotate: part one");
    await first.stop();
    // Rotation step 1: the new key signs, the old one still verifies.
    const second = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      wsPort: first.wsPort,
      sessionKey: `${KEY_ROTATED},${KEY}`,
    });
    await second.reconcile();
    second.pump();

    expect((await settle(stack.v1, conversation.id, turnId))?.status).toBe(
      "done",
    );
    expect(second.containerRefOf(cx.ids.sandbox)).toBe(containerBefore);
    await second.stop();
    await second.reap();
  },
);

scenario(
  "the key is DROPPED between the two processes: the session is refused, the old path recovers the box",
  async (cx) => {
    const stack = await cx.startStack({ withRunner: false });
    const first = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      sessionKey: KEY,
    });
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, { runnerId: first.runnerId });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    first.pump();
    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    expect((await runTurn(stack.v1, conversation.id, "warm up")).status).toBe(
      "done",
    );
    const containerBefore = first.containerRefOf(cx.ids.sandbox);
    await first.stop();

    // A runner with a DIFFERENT key only: every session it is shown fails.
    const second = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      wsPort: first.wsPort,
      sessionKey: KEY_ROTATED,
    });
    await second.reconcile();
    second.pump();

    // The reconnect is refused (wrong key), the one bootstrap fallback is
    // refused too (the token died with the first process), and the
    // supervisor then spends its retry budget (~15 min) before exiting.
    // Two things are observable inside a test's patience: (1) the new runner
    // never gets a connection for this sandbox, and (2) once the container is
    // gone the ordinary recreate path takes the next turn. The budget itself
    // is pinned in the transport's unit tests; here the kill stands in for
    // its expiry.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(second.hasConnection(cx.ids.sandbox)).toBe(false);
    expect(second.containerRefOf(cx.ids.sandbox)).toBe(containerBefore);
    await dockerKill(containerNameFor(cx.ids.sandbox));
    await reconcileUntilStopped(second, cx.ids.sandbox);

    const after = await runTurn(
      stack.v1,
      conversation.id,
      "after the key loss",
    );
    expect(after.status).toBe("done");
    expect(second.containerRefOf(cx.ids.sandbox)).not.toBe(containerBefore);
    await second.stop();
    await second.reap();
  },
);

scenario(
  "the replacement runner is NOT where the sandboxes dial (misconfigured address): past the grace the old recovery runs",
  async (cx) => {
    // The supervisor keeps retrying the address it was given; if the
    // replacement listens elsewhere it never arrives. Inside the grace the
    // runner waits (correct: it cannot tell a slow reconnect from a lost
    // one); past it, the inherited sandbox is reported stopped and a turn
    // held for it fails with the restart copy, so the next message recreates
    // through the ordinary path. The grace is shortened to seconds here.
    const stack = await cx.startStack({ withRunner: false });
    const first = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      sessionKey: KEY,
    });
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, { runnerId: first.runnerId });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    first.pump();
    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    expect((await runTurn(stack.v1, conversation.id, "warm up")).status).toBe(
      "done",
    );
    const containerBefore = first.containerRefOf(cx.ids.sandbox);
    await first.stop();

    // A different port: the supervisor's reconnects go to nobody. Pinned
    // explicitly (a fresh free port can be the one just released).
    const second = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      wsPort: first.wsPort + 1,
      sessionKey: KEY,
      inheritedResumeGraceMs: 3_000,
    });
    await second.reconcile();
    expect(
      second.posted.filter(
        (e) => e.kind === "sandbox.status" && e.status === "stopped",
      ),
    ).toEqual([]);
    second.pump();

    // A turn inside the grace is HELD; when the grace runs out it is failed
    // with the restart code and the sandbox reported stopped. That is the
    // pre-feature recovery, and from there the control plane's cold-revival
    // takes over: a turn that never started is re-queued invisibly, the
    // next start recreates the container (which dials the NEW address), and
    // the same turn ends `done` on it. The user never sees a failure.
    const turnId = await postTurn(stack.v1, conversation.id, "while waiting");
    const settled = await settle(stack.v1, conversation.id, turnId);
    expect(settled?.status).toBe("done");
    expect(
      second.posted.filter(
        (e) =>
          e.kind === "turn.finished" &&
          e.turnId === turnId &&
          e.errorCode === "agent_restarted",
      ),
    ).toHaveLength(1);
    expect(
      second.posted.some(
        (e) => e.kind === "sandbox.status" && e.status === "stopped",
      ),
    ).toBe(true);
    expect(second.containerRefOf(cx.ids.sandbox)).not.toBe(containerBefore);
    await second.stop();
    await second.reap();
  },
);

scenario(
  "the PRODUCTION inherited grace (3 min) on a supervisor that never comes back: the 90 s re-claims are absorbed, the box is recovered just past 3 min, one batch",
  async (cx) => {
    // While a turn is held the box still reads `running`, so the control
    // plane re-hands the same turn every 90 s. Unabsorbed, the copies stack
    // up behind one hold and all fire at expiry.
    // Same shape as the misconfigured-address leg, on the DEFAULT inherited
    // grace (no override): the real 3 min value, long enough for two 90 s
    // re-claims, and the recovery must land just past it.
    const stack = await cx.startStack({ withRunner: false });
    const first = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      sessionKey: KEY,
    });
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, { runnerId: first.runnerId });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    first.pump();
    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    expect((await runTurn(stack.v1, conversation.id, "warm up")).status).toBe(
      "done",
    );
    await first.stop();

    // Anchored BEFORE the replacement starts: the runner takes its own
    // inherited-grace anchor inside `start()`, so it is never earlier than
    // this one and the 3 min lower bound below holds by construction.
    const bootedAt = Date.now();
    const second = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      wsPort: first.wsPort + 1,
      sessionKey: KEY,
    });
    await second.reconcile();
    second.pump();

    const turnId = await postTurn(stack.v1, conversation.id, "held long");
    // The control plane's re-claim: the turn's dispatch stamp moves past
    // its first value while the runner still holds it.
    const firstDispatch = (
      await cx.prisma.turn.findUniqueOrThrow({ where: { id: turnId } })
    ).updatedAt;
    await waitFor(
      async () =>
        (await cx.prisma.turn.findUniqueOrThrow({ where: { id: turnId } }))
          .updatedAt,
      (stamp) => stamp > firstDispatch,
      "the stale-dispatch re-claim of the held turn",
      240_000,
    );

    const settled = await waitFor(
      () => readTurn(stack.v1, conversation.id, turnId),
      (turn) =>
        turn !== null && ["done", "failed", "aborted"].includes(turn.status),
      `turn ${turnId} to settle`,
      240_000,
    );
    expect(settled?.status).toBe("done");
    // Recovered on the production default: not before 3 min, and not the
    // old ~15.5 min (a minute of slack for the fresh boot and the turn).
    const recoveredAfterMs = Date.now() - bootedAt;
    expect(recoveredAfterMs).toBeGreaterThan(180_000);
    expect(recoveredAfterMs).toBeLessThan(240_000);
    // ONE channel-loss batch for the whole hold, however many copies the
    // control plane handed over; the second turn.finished for this id is
    // the revived turn's own `done` on the fresh boot.
    const finished = second.posted.filter(
      (e): e is Extract<RunnerEvent, { kind: "turn.finished" }> =>
        e.kind === "turn.finished" && e.turnId === turnId,
    );
    expect(finished.map((e) => e.status)).toEqual(["failed", "done"]);
    expect(finished[0]?.errorCode).toBe("agent_restarted");
    expect(
      second.posted.filter(
        (e) =>
          e.kind === "sandbox.status" &&
          e.sandboxId === cx.ids.sandbox &&
          e.status === "stopped",
      ),
    ).toHaveLength(1);
    await second.stop();
    await second.reap();
  },
  360_000,
);

scenario(
  "an OLD supervisor (pre-feature agent image) against a keyed runner: exactly the old behaviour, no errors",
  async (cx) => {
    const oldImage = cx.config.oldAgentImage;
    if (!oldImage) {
      console.warn(
        "E2E_OLD_AGENT_IMAGE unset: old-supervisor scenario skipped",
      );
      return;
    }
    const stack = await cx.startStack({ withRunner: false });
    const first = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      sessionKey: KEY,
      agentImage: oldImage,
    });
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, { runnerId: first.runnerId });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    first.pump();
    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    // The old supervisor drops the `session` item it does not know and talks
    // bare frames; a keyed runner must accept both without complaint.
    expect(
      (await runTurn(stack.v1, conversation.id, "old supervisor")).status,
    ).toBe("done");
    const containerBefore = first.containerRefOf(cx.ids.sandbox);
    await first.stop();
    const second = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      wsPort: first.wsPort,
      sessionKey: KEY,
      agentImage: oldImage,
    });
    // No session was ever held, so the drop is a death as before. The new
    // process cannot know that from the container alone (it inherits every
    // running one the same way), so it waits out the resume grace for the
    // old supervisor too, which never comes; the next turn, held for that
    // grace, then fails and recreates. Too slow for a test, so stand in for
    // the expiry: kill the container, reconcile, and the old contract takes
    // over (stopped → recreate).
    await second.reconcile();
    await dockerKill(containerNameFor(cx.ids.sandbox));
    await reconcileUntilStopped(second, cx.ids.sandbox);
    second.pump();
    const after = await runTurn(stack.v1, conversation.id, "after the restart");
    expect(after.status).toBe("done");
    expect(second.containerRefOf(cx.ids.sandbox)).not.toBe(containerBefore);
    await second.stop();
    await second.reap();
  },
);

scenario(
  "the FIRST deploy shape: a sandbox spawned by a keyless runner, inherited by a keyed one, recovers at once (no grace for a supervisor that can hold no session)",
  async (cx) => {
    // The old process ran without the key, so its sandbox's supervisor
    // holds no session and retries a dead token for its whole budget. The
    // keyed successor must NOT grant that container the resume grace: it
    // carries no `resumable` mark, so the first reconcile reports it
    // stopped and the next turn takes the ordinary cold wake, exactly the
    // pre-feature contract. With the grace wrongly granted the turn would
    // sit `dispatched` for the whole ~15 min budget.
    const stack = await cx.startStack({ withRunner: false });
    const first = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      // No key: the pre-feature runner.
    });
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, { runnerId: first.runnerId });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    first.pump();
    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    expect(
      (await runTurn(stack.v1, conversation.id, "before the key")).status,
    ).toBe("done");
    const containerBefore = first.containerRefOf(cx.ids.sandbox);
    await first.stop();

    const second = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      wsPort: first.wsPort,
      sessionKey: KEY,
      // The production grace. The point: it must not apply here at all.
    });
    // The inherited container is NOT marked resumable: start()'s own
    // reconcile reports it stopped right away, no kill needed.
    expect(
      second.posted.filter(
        (e) => e.kind === "sandbox.status" && e.status === "stopped",
      ),
    ).toHaveLength(1);
    second.pump();

    const t0 = Date.now();
    const after = await runTurn(stack.v1, conversation.id, "after the key");
    expect(after.status).toBe("done");
    // The ordinary cold wake, not a held turn: well inside a minute.
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(second.containerRefOf(cx.ids.sandbox)).not.toBe(containerBefore);
    // And the NEW container carries the mark, so the next roll resumes.
    expect(await second.resumableOf(cx.ids.sandbox)).toBe(true);
    await second.stop();
    await second.reap();
  },
);
