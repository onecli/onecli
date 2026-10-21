import { randomUUID } from "node:crypto";
import type { RunnerEvent, WorkItem } from "@onecli/agent-protocol";
import type { RunnerConfig } from "@onecli/runner/config";
import {
  ControlPlaneError,
  createControlPlaneClient,
} from "@onecli/runner/control-plane";
import { createDockerBackend } from "@onecli/runner/backend/docker";
import { installationFingerprint } from "@onecli/runner/installation";
import { createRunner } from "@onecli/runner/runner";
import { createChannelPlane } from "@onecli/runner/ws/channel-plane";
import { createRunnerWsServer } from "@onecli/runner/ws/server";
import { parseSessionKeyring } from "@onecli/runner/ws/session";
import { createSupervisorMessageHandler } from "@onecli/runner/supervisor-messages";
import { createTurnEventCollector } from "@onecli/runner/turn-events";
import type { HostedE2EConfig } from "./env.js";
import type { TestIds } from "./ids.js";
import { freePort } from "./ports.js";
import { waitFor } from "./v1.js";

/**
 * The runner, IN-PROCESS — the one deliberate departure from "everything is
 * a child". `createRunner` exposes `tick()`/`reconcile()` precisely so tests
 * can drive the loop deterministically ("pause pumping, assert the held
 * state, resume"), and "restart the runner" becomes stop + a fresh instance
 * on the same token (same Runner row) in milliseconds. The REAL docker
 * backend and REAL ws server still run — the wire (spawn payloads,
 * supervisor frames, event posting) is byte-identical to production; only
 * `src/index.ts`'s process shell is replicated here (its report chain,
 * collector, channel plane and late-bound sandbox channel, condensed).
 *
 * Each handle is ONE runner copy: its own registration (a fresh replica
 * name), its own ws server. Several handles on the same token are several
 * copies of one runner; put them behind one address (`advertisedPort`, a
 * test balancer in front) and they are the production multi-copy shape.
 *
 * Networking: a per-test NON-internal bridge (the sanctioned local-dev
 * posture — the gateway runs on the host) with `host-gateway` ExtraHosts so
 * Linux containers resolve the host too. The `internal: true` posture ships
 * in `docker/docker-compose.yml` and is not CI-proven at the network layer;
 * its logic guards are the runner's fail-closed refusal of a non-internal
 * network (orphan-reap.test.ts) and the gateway's untokened-407
 * (gateway-e2e auth.test.ts).
 */

export interface TestRunnerHandle {
  readonly runnerId: string;
  /** This copy's name (its registration names it, like a pod's hostname). */
  readonly replicaName: string;
  /** This copy's own listen port. */
  readonly wsPort: number;
  /** One poll pass: claims work, executes serially, reports. */
  tick(wait?: number): Promise<void>;
  /** One reconcile pass (owned loops + the stale-label orphan sweep). */
  reconcile(): Promise<void>;
  /** Background pump: tick(1) in a loop until paused/stopped. */
  pump(): void;
  pausePump(): Promise<void>;
  /**
   * Whether the sandbox's live container carries the `resumable` mark (read
   * from the substrate, the way a restarted runner would), or undefined
   * when it has no container.
   */
  resumableOf(sandboxId: string): Promise<boolean | undefined>;
  /** Does THIS copy hold the sandbox's live supervisor socket? */
  hasConnection(sandboxId: string): boolean;
  /** Every event this copy posted to the control plane, in order. */
  readonly posted: readonly RunnerEvent[];
  /**
   * The graceful stop (a roll): retire this copy (it is handed nothing new
   * from here on), drain every socket (1012, they move to another copy),
   * close. Sandboxes stay running.
   */
  stop(): Promise<void>;
  /**
   * The CRASH shape: the process vanishes with no graceful close. Every
   * supervisor socket is destroyed at the TCP level (no close frame), the
   * loop is abandoned, nothing is drained or retired. What a SIGKILL or an
   * OOM leaves; the copy's identity lingers until the liveness window.
   */
  crash(): Promise<void>;
  /** Stop AND remove every container/volume this runner's label owns. */
  reap(): Promise<void>;
}

export interface StartRunnerOptions {
  controlPlaneUrl: string;
  ids: TestIds;
  config: HostedE2EConfig;
  maxSandboxes?: number;
  orphanGraceSeconds?: number;
  orphanReap?: boolean;
  /**
   * The supervisor-session signing keyring (`RUNNER_SESSION_KEY` shape).
   * Absent = resumption off, the pre-feature posture every other scenario
   * runs under; the resume scenarios set it on BOTH the first runner and
   * its replacement, exactly like a fleet sharing one secret.
   */
  sessionKey?: string;
  /** Override the agent image (the old-supervisor compatibility scenario). */
  agentImage?: string;
  /**
   * Override the inherited-resume grace (production: 3 min) so the
   * "supervisor never came back" legs fit a test.
   */
  inheritedResumeGraceMs?: number;
  /**
   * Listen on THIS port instead of a fresh free one. A replacement runner
   * must sit where the sandboxes were told to dial (production: the stable
   * address the deployment hands its sandboxes), or no supervisor can ever
   * find it again.
   */
  wsPort?: number;
  /**
   * The port sandboxes are told to dial, when it is not this copy's own
   * (several copies behind one test balancer: each listens on its own port,
   * every sandbox dials the balancer's).
   */
  advertisedPort?: number;
  /**
   * Reproduce the CLOUD backend's ordering on Docker: `createSandbox` returns
   * only after the container is running (the cloud backend's image watch),
   * so the runner records the spawn AFTER the supervisor first dialled. That
   * first dial is refused (no spawn recorded yet) and the supervisor redials
   * until the record lands.
   */
  createReturnsAfterConnect?: boolean;
}

export const startTestRunner = async (
  opts: StartRunnerOptions,
): Promise<TestRunnerHandle> => {
  const wsPort = opts.wsPort ?? (await freePort());

  const runnerConfig: RunnerConfig = {
    token: opts.ids.runnerToken,
    controlPlaneUrl: opts.controlPlaneUrl,
    name: `hosted-e2e-${opts.ids.nonce}`,
    // One copy per handle: a fresh name each, like a pod's hostname.
    replicaName: `hosted-e2e-copy-${randomUUID().slice(0, 8)}`,
    backend: "docker",
    // 1 = the self-host serialization posture; the e2e pins today's behavior.
    lifecycleConcurrency: 1,
    agentImage: opts.agentImage ?? opts.config.agentImage,
    sandboxNetwork: opts.ids.network,
    networkInternal: false,
    wsPort,
    advertisedHost: opts.config.hostGatewayHost,
    advertisedPort: opts.advertisedPort ?? wsPort,
    maxSandboxes: opts.maxSandboxes ?? 4,
    limits: { memoryMb: 1024, cpus: 1, pids: 512 },
    // Tests own reconcile timing — the timer must never race a scenario.
    reconcileSeconds: 3600,
    dockerSocket: opts.config.dockerSocket,
    sandboxExtraHosts: [`${opts.config.hostGatewayHost}:host-gateway`],
    orphanReap: opts.orphanReap ?? true,
    orphanGraceSeconds: opts.orphanGraceSeconds ?? 3600,
    // Cloud-backend settings — inert here: hosted-e2e is the DOCKER path.
    sandboxManagerUrl: null,
    sandboxManagerToken: null,
    sessionKey: opts.sessionKey ?? null,
    // No preview relay in the e2e: the port API stays closed.
    portApi: null,
    // The stub upstreams live on the HOST's 127.0.0.1 and are reached
    // THROUGH the gateway (that is the injection proof), so loopback must
    // stay proxied here; real sandboxes exempt it.
    noProxyLoopback: false,
    cloudParkWaitSeconds: 120,
    cloudWakeWaitSeconds: 900,
    cloudImageWaitSeconds: 240,
  };

  const docker = createDockerBackend({
    runnerId: randomUUID(),
    installationId: installationFingerprint(runnerConfig.token),
    network: runnerConfig.sandboxNetwork,
    networkInternal: runnerConfig.networkInternal,
    socketPath: runnerConfig.dockerSocket,
    extraHosts: runnerConfig.sandboxExtraHosts,
  });
  // The cloud ordering: start inside create, and return only once the
  // container runs and a little longer, so its supervisor's first dial
  // lands before the spawn is recorded.
  const backend: typeof docker = opts.createReturnsAfterConnect
    ? {
        ...docker,
        createSandbox: async (spec) => {
          const ref = await docker.createSandbox(spec);
          await docker.startSandbox(ref);
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          return ref;
        },
      }
    : docker;

  const client = createControlPlaneClient({
    baseUrl: runnerConfig.controlPlaneUrl,
    token: runnerConfig.token,
  });
  // Every event that reaches the control plane, whichever runner path posted
  // it (the message handler's report chain or reconcile's own batch): the
  // observable a scenario asserts on.
  const posted: RunnerEvent[] = [];
  // A crashed process makes no more calls: no heartbeat, no poll, no
  // report, no channel release. In-process, its timers and in-flight poll
  // would otherwise keep refreshing its liveness (and its ownership) after
  // the "crash", which no real crash does.
  let crashed = false;
  const controlPlane: typeof client = new Proxy(
    {
      ...client,
      postEvents: (events: RunnerEvent[]) => {
        posted.push(...events);
        return client.postEvents(events);
      },
    },
    {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) =>
          crashed
            ? Promise.reject(new Error("runner process crashed"))
            : Reflect.apply(value, target, args);
      },
    },
  );

  // The production report chain, condensed: serialized, error-tolerant.
  let reportChain: Promise<void> = Promise.resolve();
  const report = (event: RunnerEvent): void => {
    reportChain = reportChain.then(() =>
      controlPlane.postEvents([event]).catch((error: unknown) => {
        console.warn(`hosted-e2e runner report failed: ${String(error)}`);
      }),
    );
  };
  const collector = createTurnEventCollector({ post: report });

  let sendToSandbox: (sandboxId: string, item: WorkItem) => boolean = () =>
    false;
  let containerRefOf: (sandboxId: string) => string | undefined = () =>
    undefined;
  // The production composition root's wiring, condensed: the keyring parsed
  // once, the channel plane over the control-plane client.
  const keyring = parseSessionKeyring(runnerConfig.sessionKey ?? undefined);
  const channels = createChannelPlane({ client: controlPlane });
  const wsServer = createRunnerWsServer({
    port: wsPort,
    channels,
    ...(keyring && { keyring }),
    onMessage: createSupervisorMessageHandler({
      report,
      collector,
      toolCall: (sandboxId, callMessage) =>
        controlPlane.toolCall({
          sandboxId,
          tool: callMessage.tool,
          args: callMessage.args,
          ...(callMessage.conversationId && {
            conversationId: callMessage.conversationId,
          }),
          ...(callMessage.turnId && { turnId: callMessage.turnId }),
        }),
      memoryWrite: async (sandboxId, writeMessage) => {
        try {
          return await controlPlane.memoryWrite({
            sandboxId,
            key: writeMessage.key,
            content: writeMessage.content,
            ...(writeMessage.title !== undefined && {
              title: writeMessage.title,
            }),
            ...(writeMessage.description !== undefined && {
              description: writeMessage.description,
            }),
            ...(writeMessage.conversationId && {
              conversationId: writeMessage.conversationId,
            }),
            ...(writeMessage.turnId && { turnId: writeMessage.turnId }),
          });
        } catch (error) {
          if (error instanceof ControlPlaneError && error.status === 400) {
            return {
              ok: false,
              error: "The platform refused this memory file's shape.",
            };
          }
          throw error;
        }
      },
      // The real client, so the e2e proves the raw-body POST and its caps.
      uploadAttachment: (sandboxId, file) =>
        controlPlane.uploadAttachment(sandboxId, file),
      sendToSandbox: (sandboxId, item) => sendToSandbox(sandboxId, item),
      containerRefOf: (sandboxId) => containerRefOf(sandboxId),
    }),
  });
  sendToSandbox = (sandboxId, item) => {
    const connection = wsServer.connection(sandboxId);
    if (!connection) return false;
    connection.send(item);
    return true;
  };
  containerRefOf = (sandboxId) => wsServer.containerRefOf(sandboxId);

  const runner = createRunner({
    config: runnerConfig,
    backend,
    controlPlane,
    wsServer,
    ...(opts.inheritedResumeGraceMs !== undefined && {
      inheritedResumeGraceMs: opts.inheritedResumeGraceMs,
    }),
  });

  const runnerId = await runner.start();

  let pumping = false;
  let pumpDone: Promise<void> = Promise.resolve();
  const pump = (): void => {
    if (pumping) return;
    pumping = true;
    pumpDone = (async () => {
      while (pumping) {
        try {
          await runner.tick(1);
        } catch (error) {
          console.warn(`hosted-e2e runner tick failed: ${String(error)}`);
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    })();
  };
  const pausePump = async (): Promise<void> => {
    pumping = false;
    await pumpDone;
  };

  return {
    runnerId,
    replicaName: runnerConfig.replicaName,
    wsPort,
    tick: (wait = 0) => runner.tick(wait),
    reconcile: () => runner.reconcile(),
    pump,
    pausePump,
    resumableOf: async (sandboxId) =>
      (await backend.listSandboxes()).find(
        (snapshot) => snapshot.sandboxId === sandboxId && snapshot.running,
      )?.resumable,
    hasConnection: (sandboxId) => wsServer.connection(sandboxId) !== undefined,
    posted,
    stop: async () => {
      await pausePump();
      await runner.stop();
      await Promise.all([reportChain, channels.settled()]);
    },
    crash: async () => {
      pumping = false;
      crashed = true;
      await wsServer.crash();
      // The pump's in-flight tick and the runner's timers fail from here on;
      // nothing reaches the control plane again.
    },
    reap: async () => {
      // `runner.stop()` deliberately leaves sandboxes running (production
      // semantics); a scenario must not. Stop+remove every owned container,
      // destroy every owned home — then the network can go too.
      for (const snapshot of await backend.listSandboxes()) {
        await backend.stopSandbox(snapshot.containerRef).catch(() => {});
        await backend.removeSandbox(snapshot.containerRef).catch(() => {});
      }
      for (const home of await backend.listHomes()) {
        await backend.destroyHome(home.ref).catch(() => {});
      }
    },
  };
};

/**
 * Drive reconcile until the runner has reported the sandbox `stopped`.
 * `docker kill` returns once the signal is SENT; the engine can still list
 * the container as running for a beat after, and a single reconcile in that
 * beat sees a running, in-grace box and (correctly) reports nothing. The
 * production cadence re-checks on its own; the suite pins reconcile to
 * 3600 s so a test drives it by hand, the way the hardening leg does.
 */
export const reconcileUntilStopped = (
  runner: TestRunnerHandle,
  sandboxId: string,
): Promise<boolean> =>
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
