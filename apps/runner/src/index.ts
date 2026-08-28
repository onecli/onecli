import { randomUUID } from "node:crypto";
import type { RunnerEvent, WorkItem } from "@onecli/agent-protocol";
import { ConfigError, loadConfig, type RunnerConfig } from "./config";
import { installationFingerprint } from "./installation";
import { ControlPlaneError, createControlPlaneClient } from "./control-plane";
import { createCloudBackend } from "./backend/cloud/cloud-backend";
import { createDockerBackend } from "./backend/docker/docker-backend";
import { createFakeBackend } from "./backend/fake";
import type { SandboxBackend } from "./backend/types";
import { createRunner } from "./runner";
import { createRunnerWsServer } from "./ws/server";
import { createSupervisorMessageHandler } from "./supervisor-messages";
import { createTurnEventCollector } from "./turn-events";
import { log } from "./log";

/**
 * Composition root. The ONLY place a backend id maps to an implementation —
 * everything else speaks the SandboxBackend seam, so adding a substrate is a
 * new module plus one line here (§3.14 rule 2).
 */
const selectBackend = (
  config: RunnerConfig,
  options: {
    runnerId: string;
    installationId: string;
  },
): SandboxBackend => {
  if (config.backend === "fake") return createFakeBackend();
  if (config.backend === "cloud") {
    // loadConfig already refused to boot without these two; the non-null
    // assertion-free narrowing here keeps that single source of truth.
    if (!config.sandboxManagerUrl || !config.sandboxManagerToken) {
      throw new ConfigError(
        "cloud backend selected without sandbox-manager settings.",
      );
    }
    return createCloudBackend({
      runnerId: options.runnerId,
      installationId: options.installationId,
      managerUrl: config.sandboxManagerUrl,
      managerToken: config.sandboxManagerToken,
      parkWaitSeconds: config.cloudParkWaitSeconds,
      wakeWaitSeconds: config.cloudWakeWaitSeconds,
      imageWaitSeconds: config.cloudImageWaitSeconds,
    });
  }
  if (config.backend !== "docker") {
    throw new ConfigError(
      `Unknown RUNNER_BACKEND "${config.backend}" — expected "docker", "cloud" or "fake".`,
    );
  }
  return createDockerBackend({
    runnerId: options.runnerId,
    installationId: options.installationId,
    network: config.sandboxNetwork,
    networkInternal: config.networkInternal,
    socketPath: config.dockerSocket,
    extraHosts: config.sandboxExtraHosts,
  });
};

/** Queue depth past which reports are dropped rather than accumulated. */
const MAX_QUEUED_REPORTS = 200;

/** Longest a drain may hold the process open at shutdown. */
const SHUTDOWN_DRAIN_MS = 5_000;

const main = async (): Promise<void> => {
  const config = loadConfig();

  // A per-process id for correlating this run's log lines. Object labels use
  // the control plane's stable runner id instead (the backend adopts it right
  // after registration), so a restart still recognizes what it created.
  const localId = randomUUID();

  const backend = selectBackend(config, {
    runnerId: localId,
    installationId: installationFingerprint(config.token),
  });

  const controlPlane = createControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    token: config.token,
  });

  /**
   * Reports are posted one at a time, in the order they were made.
   *
   * They have to be. `seq` — the number the whole transcript contract rests on
   * — is assigned control-plane-side when a batch ARRIVES, so posting
   * concurrently means arrival order decides the numbering: a large batch and
   * the small terminal flush behind it can land in either order, and the
   * transcript then says the turn finished before the tool call it made. The
   * collector emits chunks in order; only this keeps them that way on the wire.
   *
   * Serializing globally rather than per turn is deliberate — one chain is
   * simpler than a map of them, and every post is bounded by the client's 15s
   * timeout, so a dead control plane delays reporting rather than wedging it.
   */
  let reportChain: Promise<void> = Promise.resolve();
  /** How many posts are queued behind the one in flight. */
  let queuedReports = 0;

  const report = (event: RunnerEvent): void => {
    // BOUNDED. Each post is capped at 15s per attempt — with the client's
    // bounded retry (retryable statuses only), a post can hold the chain
    // head ~75s worst case — while a sandbox — untrusted, running
    // model-driven code — can enqueue as fast as it emits. Unbounded, the
    // queue grows closures holding up to 256 KB each, in the one process that
    // holds the docker socket and hosts every tenant on the box.
    if (queuedReports >= MAX_QUEUED_REPORTS) {
      log("warn", "report queue full; dropping an event", {
        sandboxId: "sandboxId" in event ? event.sandboxId : undefined,
        kind: event.kind,
      });
      return;
    }
    queuedReports += 1;
    reportChain = reportChain
      .then(() =>
        controlPlane.postEvents([event]).catch((error: unknown) => {
          log("warn", "failed to report a supervisor message", {
            // From the event itself — every kind carries the real one.
            sandboxId: "sandboxId" in event ? event.sandboxId : undefined,
            kind: event.kind,
            error: String(error),
          });
        }),
      )
      .finally(() => {
        queuedReports -= 1;
      });
  };

  // Text is buffered here rather than posted per token (§3.17's delta law);
  // the collector also chunks so a flush can never exceed the wire's cap.
  const collector = createTurnEventCollector({ post: report });

  // Late-bound: the handler needs to send tool results back down a channel
  // the server owns, and the server needs the handler at construction. The
  // ref is assigned immediately below, before any connection can exist.
  let sendToSandbox: (sandboxId: string, item: WorkItem) => boolean = () =>
    false;
  // Same late-bind as sendToSandbox: the message handler needs the runner's
  // container map, but the handler is built before the runner. Reassigned to
  // the real lookup immediately after createRunner, before any connection
  // (and so any process.state frame) can exist.
  let containerRefOf: (sandboxId: string) => string | undefined = () =>
    undefined;
  const wsServer = createRunnerWsServer({
    port: config.wsPort,
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
          // A 400 is the control plane refusing THIS content (schema) —
          // terminal for these bytes, so the harvester must not re-send
          // until the file changes. Everything else rethrows into the
          // relay's retryable transport arm.
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

  const runner = createRunner({ config, backend, controlPlane, wsServer });
  containerRefOf = (sandboxId) => runner.containerRefOf(sandboxId);

  /**
   * Shutdown has to DRAIN, not just stop.
   *
   * Buffered transcript text and a queued `turn.finished` both live in this
   * process: the collector holds up to a flush interval of events, and every
   * report is queued on `reportChain`. Exiting without emptying them loses
   * that text and — far worse — can strand a turn that actually finished,
   * which the active-turn index then blocks its conversation on until the
   * ceiling half an hour later. On every deploy.
   */
  const shutdown = (signal: string) => {
    log("info", "shutting down", { signal });
    const drain = async () => {
      await runner.stop().catch((error: unknown) => {
        log("warn", "shutdown error", { error: String(error) });
      });
      collector.flushAll();
      // Bounded: a control plane that is itself down must not hold the
      // process open past its termination grace period. The runner's own
      // settle covers in-flight lifecycle work and ITS report chain (step 4).
      await Promise.race([
        Promise.all([runner.settle(), reportChain]),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS)),
      ]);
    };
    drain()
      .catch((error: unknown) =>
        log("warn", "shutdown drain failed", { error: String(error) }),
      )
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const runnerId = await runner.start();
  log("info", "runner started", { runnerId, localId, backend: backend.id });

  await runner.run();
};

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    log("error", error.message);
    process.exit(2);
  }
  log("error", "runner crashed", { error: String(error) });
  process.exit(1);
});
