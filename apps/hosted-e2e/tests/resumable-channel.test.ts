import { expect } from "vitest";
import { scenario, type Cx } from "../src/scenario.js";
import { containerNameFor, dockerKill, dockerLogs } from "../src/docker.js";
import {
  containerOf,
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, sleep, text } from "../src/fake-dsl.js";
import { freePortOtherThan } from "../src/ports.js";
import {
  reconcileUntilStopped,
  startTestRunner,
  type TestRunnerHandle,
} from "../src/runner.js";
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
 * the spawn before the container starts, so the first dial is admitted) and
 * the cloud backend's (create returns only once the container runs, so the
 * supervisor's first dial can arrive before the spawn is recorded, is
 * refused, and must redial until it is admitted and handed its session).
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
  const containerBefore = await containerOf(cx.prisma, cx.ids.sandbox);
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
  expect(await containerOf(cx.prisma, cx.ids.sandbox)).toBe(containerBefore);
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
  "the same restart under the CLOUD creation order (create returns once the container runs, after its supervisor first dialled): the first dial is refused, the redial is admitted, and the session still resumes",
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
    const containerBefore = await containerOf(cx.prisma, cx.ids.sandbox);

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
    expect(await containerOf(cx.prisma, cx.ids.sandbox)).toBe(containerBefore);
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
    const containerBefore = await containerOf(cx.prisma, cx.ids.sandbox);

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
    expect(await containerOf(cx.prisma, cx.ids.sandbox)).toBe(containerBefore);
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
    const containerBefore = await containerOf(cx.prisma, cx.ids.sandbox);
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

    // Every reconnect is refused (wrong key; the supervisor keeps presenting
    // its session, since its bootstrap token was spent on the first
    // connect), and the supervisor then spends its retry budget (~15 min)
    // before exiting.
    // Two things are observable inside a test's patience: (1) the new runner
    // never gets a connection for this sandbox, and (2) once the container is
    // gone the ordinary recreate path takes the next turn. The budget itself
    // is pinned in the transport's unit tests; here the kill stands in for
    // its expiry.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(second.hasConnection(cx.ids.sandbox)).toBe(false);
    expect(await containerOf(cx.prisma, cx.ids.sandbox)).toBe(containerBefore);
    await dockerKill(containerNameFor(cx.ids.sandbox));
    await reconcileUntilStopped(second, cx.ids.sandbox);

    const after = await runTurn(
      stack.v1,
      conversation.id,
      "after the key loss",
    );
    expect(after.status).toBe("done");
    expect(await containerOf(cx.prisma, cx.ids.sandbox)).not.toBe(
      containerBefore,
    );
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
    // one) and a turn simply waits for the socket (only the copy holding
    // it is handed turns); past it, the inherited sandbox is reported
    // stopped, and the waiting turn rides the ordinary wake: the start
    // recreates the container (which dials the NEW address) and the same
    // turn ends `done` on it. The user never sees a failure. The grace is
    // shortened to seconds here.
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
    const containerBefore = await containerOf(cx.prisma, cx.ids.sandbox);
    await first.stop();

    // A different port: the supervisor's reconnects go to nobody. A fresh
    // one from the OS, never the old one (a neighbour like old + 1 can be
    // held by anything on the host).
    const second = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      wsPort: await freePortOtherThan(first.wsPort),
      sessionKey: KEY,
      inheritedResumeGraceMs: 3_000,
    });
    expect(
      second.posted.filter(
        (e) => e.kind === "sandbox.status" && e.status === "stopped",
      ),
    ).toEqual([]);
    second.pump();

    const turnId = await postTurn(stack.v1, conversation.id, "while waiting");
    // Production reconciles every 60 s; the suite drives it by hand.
    await new Promise((r) => setTimeout(r, 3_500));
    await reconcileUntilStopped(second, cx.ids.sandbox);
    const settled = await settle(stack.v1, conversation.id, turnId);
    expect(settled?.status).toBe("done");
    // Never handed to a copy without the socket, so never given back.
    expect(
      second.posted.filter(
        (e) => e.kind === "turn.finished" && e.errorCode === "agent_restarted",
      ),
    ).toEqual([]);
    expect(await containerOf(cx.prisma, cx.ids.sandbox)).not.toBe(
      containerBefore,
    );
    await second.stop();
    await second.reap();
  },
);

/**
 * The inherited-grace leg's clocks, shortened so the leg runs in seconds
 * while keeping the property only a long wait shows: the grace spans
 * several of the control plane's stale-dispatch windows (production: 90 s
 * against a 180 s grace), so a waiting turn that a socketless copy could be
 * re-handed would be re-handed here, and fail the leg. The shipped 180 s
 * default itself is pinned by the runner's unit test ("ships a 3 min
 * inherited grace").
 */
const STALE_DISPATCH_SECONDS = 4;
const INHERITED_GRACE_MS = 12_000;

scenario(
  "an inherited grace spanning several stale-dispatch windows on a supervisor that never comes back: the box is recovered just past the grace, never before, and the waiting turn ends `done`",
  async (cx) => {
    // Same shape as the misconfigured-address leg, with the grace three
    // stale-dispatch windows long. The turn waits for a socket the whole
    // time (no copy holds one, so none is handed it, however many windows
    // pass) and completes on the recreated box; the recovery must not land
    // before the grace ends.
    const stack = await cx.startStack({
      withRunner: false,
      apiEnv: { STALE_DISPATCH_SECONDS: String(STALE_DISPATCH_SECONDS) },
    });
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

    // Anchored BEFORE the replacement starts: the runner anchors the grace
    // on the later of the old copy's last heartbeat and its own start of
    // reconciling, both after this, so the lower bound holds by
    // construction.
    const bootedAt = Date.now();
    const second = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
      wsPort: await freePortOtherThan(first.wsPort),
      sessionKey: KEY,
      inheritedResumeGraceMs: INHERITED_GRACE_MS,
    });
    second.pump();
    const turnId = await postTurn(stack.v1, conversation.id, "held long");
    const postedAt = Date.now();

    // Production reconciles every 60 s; here back to back, so the report
    // lands within moments of the grace ending. This also pins the clean
    // hand-over: the old copy retired on stop, so its identity counts as
    // gone at once and the grace runs from the replacement's start.
    await waitFor(
      async () => {
        await second.reconcile();
        return second.posted.some(
          (e) =>
            e.kind === "sandbox.status" &&
            e.sandboxId === cx.ids.sandbox &&
            e.status === "stopped",
        );
      },
      (reported) => reported,
      "the inherited sandbox to be reported stopped",
      INHERITED_GRACE_MS + 60_000,
    );
    const reportedAfterMs = Date.now() - bootedAt;
    expect(reportedAfterMs).toBeGreaterThan(INHERITED_GRACE_MS);
    expect(reportedAfterMs).toBeLessThan(INHERITED_GRACE_MS + 20_000);
    // The turn waited through at least two stale-dispatch windows.
    expect(Date.now() - postedAt).toBeGreaterThan(
      2 * STALE_DISPATCH_SECONDS * 1_000,
    );

    const settled = await settle(stack.v1, conversation.id, turnId);
    expect(settled?.status).toBe("done");
    // One report for the whole wait, and the turn was never given back.
    expect(
      second.posted.filter(
        (e) =>
          e.kind === "sandbox.status" &&
          e.sandboxId === cx.ids.sandbox &&
          e.status === "stopped",
      ),
    ).toHaveLength(1);
    expect(
      second.posted.filter(
        (e) => e.kind === "turn.finished" && e.errorCode === "agent_restarted",
      ),
    ).toEqual([]);
    await second.stop();
    await second.reap();
  },
);

// Opt-in: needs a pinned pre-feature agent image. Without one it registers
// as SKIPPED, never as a pass that asserted nothing.
scenario(
  "an OLD supervisor (pre-feature agent image) against a keyed runner: exactly the old behaviour, no errors",
  async (cx) => {
    const oldImage = cx.config.oldAgentImage;
    if (oldImage === undefined) throw new Error("E2E_OLD_AGENT_IMAGE unset");
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
    const containerBefore = await containerOf(cx.prisma, cx.ids.sandbox);
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
    // old supervisor too, which never comes; the next turn waits for that
    // grace, then rides the recreate. Too slow for a test, so stand in for
    // the expiry: kill the container, reconcile, and the old contract takes
    // over (stopped → recreate).
    await second.reconcile();
    await dockerKill(containerNameFor(cx.ids.sandbox));
    await reconcileUntilStopped(second, cx.ids.sandbox);
    second.pump();
    const after = await runTurn(stack.v1, conversation.id, "after the restart");
    expect(after.status).toBe("done");
    expect(await containerOf(cx.prisma, cx.ids.sandbox)).not.toBe(
      containerBefore,
    );
    await second.stop();
    await second.reap();
  },
  {
    skipUnless: (config) =>
      config.oldAgentImage === undefined ? "set E2E_OLD_AGENT_IMAGE" : null,
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
    const containerBefore = await containerOf(cx.prisma, cx.ids.sandbox);
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
    expect(await containerOf(cx.prisma, cx.ids.sandbox)).not.toBe(
      containerBefore,
    );
    // And the NEW container carries the mark, so the next roll resumes.
    expect(await second.resumableOf(cx.ids.sandbox)).toBe(true);
    await second.stop();
    await second.reap();
  },
);
