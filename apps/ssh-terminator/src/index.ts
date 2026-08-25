import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createKubeBackend } from "./backend/kube";
import { loadTerminatorConfig } from "./config";
import { createControlPlaneClient } from "./control-plane-client";
import { startHealthServer } from "./health";
import { createConnectionLimits } from "./limits";
import { logger } from "./logger";
import { createTerminatorMetrics } from "./metrics";
import { createTerminatorServer } from "./server";

/**
 * Terminator composition root (step 5 — the SSH front door): the platform's
 * only public listener. Everything testable lives in server/session/relay;
 * this file wires the real config, the three boot secrets (direct env, or
 * Secrets Manager when an ARN is set — config presence, never edition), the
 * kube substrate backend, CloudWatch, and the drain-on-SIGTERM contract.
 * Zero standing K8s credential by design: the only cluster credential this
 * process ever holds is a per-session, broker-minted, short-TTL token.
 */

const SHUTDOWN_GRACE_MS = 20_000;

const config = loadTerminatorConfig(process.env);

// All three boot secrets load the same way the manager's do: direct env for
// tests/dev, Secrets Manager in cloud, fail-loud — a terminator that cannot
// handshake, open sessions, or broker pods serves nobody.
const secretsManager = new SecretsManagerClient({});
const fetchSecret = async (arn: string, label: string): Promise<string> => {
  const answer = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: arn }),
  );
  const value = answer.SecretString?.trim();
  if (!value) {
    throw new Error(`Secrets Manager returned an empty ${label} secret`);
  }
  return value;
};

const main = async (): Promise<void> => {
  let ready = false;
  const health = await startHealthServer({
    port: config.healthPort,
    isReady: () => ready,
  });
  logger.info({ port: health.port }, "terminator health listener up");

  let hostKey: string;
  let controlPlaneSecret: string;
  let brokerSecret: string;
  try {
    [hostKey, controlPlaneSecret, brokerSecret] = await Promise.all([
      config.hostKey ?? fetchSecret(config.hostKeySecretArn ?? "", "host key"),
      config.controlPlaneToken ??
        fetchSecret(config.controlPlaneSecretArn ?? "", "control plane"),
      config.brokerToken ?? fetchSecret(config.brokerSecretArn ?? "", "broker"),
    ]);
  } catch (error) {
    logger.error({ err: error }, "terminator secret load failed");
    process.exit(1);
  }

  if (!config.kubeServer) {
    logger.error(
      "KUBERNETES_SERVICE_HOST/PORT are not set — the terminator only runs " +
        "in-cluster (its exec dials need the API server address).",
    );
    process.exit(1);
  }

  const metrics = createTerminatorMetrics(config.metricNamespace);
  const server = createTerminatorServer({
    hostKey,
    caPublicKey: config.caPublicKey,
    controlPlane: createControlPlaneClient({
      baseUrl: config.controlPlaneUrl,
      getSecret: () => controlPlaneSecret,
    }),
    backend: createKubeBackend({
      managerUrl: config.managerUrl,
      getSecret: () => brokerSecret,
      kube: { server: config.kubeServer, caFile: config.kubeCaFile },
    }),
    metrics,
    limits: createConnectionLimits({
      maxSessions: config.maxSessions,
      maxSessionsPerIp: config.maxSessionsPerIp,
      preauthPerIpPerMinute: config.preauthPerIpPerMinute,
    }),
    wakeWaitSeconds: config.wakeWaitSeconds,
    preauthTimeoutSeconds: config.preauthTimeoutSeconds,
  });

  const port = await server.listen(config.port);
  ready = true;
  logger.info({ port }, "terminator listening");

  // One flush per minute: the live-session gauge (published zero included)
  // is the terminator's liveness heartbeat, and every counter drains here —
  // never per event (step 6).
  const stopMetricsPump = metrics.startPump(() => server.liveSessions());

  // Drain, don't drop silently: a deploy severs live sessions (accepted and
  // documented) — every one gets a banner, a close report, and its broker
  // credentials deleted before the process exits.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    logger.info({ signal, sessions: server.liveSessions() }, "draining");
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    void server
      .drain("the server is shutting down, reconnect shortly")
      // The pump's stop() runs (and awaits) the FINAL flush — it must see
      // the close counters the drain just incremented, so it runs after the
      // drain, never before it.
      .then(() => stopMetricsPump())
      .then(() => health.close())
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

void main().catch((error: unknown) => {
  logger.error({ err: error }, "terminator boot failed");
  process.exit(1);
});
