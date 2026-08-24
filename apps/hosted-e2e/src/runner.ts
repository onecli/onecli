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
import { createRunnerWsServer } from "@onecli/runner/ws/server";
import { createSupervisorMessageHandler } from "@onecli/runner/supervisor-messages";
import { createTurnEventCollector } from "@onecli/runner/turn-events";
import type { HostedE2EConfig } from "./env.js";
import type { TestIds } from "./ids.js";
import { freePort } from "./ports.js";

/**
 * The runner, IN-PROCESS — the one deliberate departure from "everything is
 * a child". `createRunner` exposes `tick()`/`reconcile()` precisely so tests
 * can drive the loop deterministically ("pause pumping, assert the held
 * state, resume"), and "restart the runner" becomes stop + a fresh instance
 * on the same token (same Runner row) in milliseconds. The REAL docker
 * backend and REAL ws server still run — the wire (spawn payloads,
 * supervisor frames, event posting) is byte-identical to production; only
 * `src/index.ts`'s process shell is replicated here (its report chain,
 * collector, and late-bound sandbox channel, condensed).
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
  readonly wsPort: number;
  /** One poll pass: claims work, executes serially, reports. */
  tick(wait?: number): Promise<void>;
  /** One reconcile pass (owned loops + the stale-label orphan sweep). */
  reconcile(): Promise<void>;
  /** Background pump: tick(1) in a loop until paused/stopped. */
  pump(): void;
  pausePump(): Promise<void>;
  containerRefOf(sandboxId: string): string | undefined;
  /** Stop the loop + ws server (leaves sandboxes running, like production). */
  stop(): Promise<void>;
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
}

export const startTestRunner = async (
  opts: StartRunnerOptions,
): Promise<TestRunnerHandle> => {
  const wsPort = await freePort();

  const runnerConfig: RunnerConfig = {
    token: opts.ids.runnerToken,
    controlPlaneUrl: opts.controlPlaneUrl,
    name: `hosted-e2e-${opts.ids.nonce}`,
    backend: "docker",
    // 1 = the self-host serialization posture; the e2e pins today's behavior.
    lifecycleConcurrency: 1,
    agentImage: opts.config.agentImage,
    sandboxNetwork: opts.ids.network,
    networkInternal: false,
    wsPort,
    advertisedHost: opts.config.hostGatewayHost,
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
    cloudParkWaitSeconds: 120,
    cloudWakeWaitSeconds: 900,
    cloudImageWaitSeconds: 240,
  };

  const backend = createDockerBackend({
    runnerId: randomUUID(),
    installationId: installationFingerprint(runnerConfig.token),
    network: runnerConfig.sandboxNetwork,
    networkInternal: runnerConfig.networkInternal,
    socketPath: runnerConfig.dockerSocket,
    extraHosts: runnerConfig.sandboxExtraHosts,
  });

  const controlPlane = createControlPlaneClient({
    baseUrl: runnerConfig.controlPlaneUrl,
    token: runnerConfig.token,
  });

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
  const wsServer = createRunnerWsServer({
    port: wsPort,
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

  const runner = createRunner({
    config: runnerConfig,
    backend,
    controlPlane,
    wsServer,
  });
  containerRefOf = (sandboxId) => runner.containerRefOf(sandboxId);

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
    wsPort,
    tick: (wait = 0) => runner.tick(wait),
    reconcile: () => runner.reconcile(),
    pump,
    pausePump,
    containerRefOf: (sandboxId) => runner.containerRefOf(sandboxId),
    stop: async () => {
      await pausePump();
      await runner.stop();
      await reportChain;
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
