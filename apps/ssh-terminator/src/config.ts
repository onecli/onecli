import { parseEd25519PublicKeyLine } from "@onecli/ssh-cert";
import { ConfigError } from "./errors";
import { resolveMetricNamespace } from "./metric-namespace";

/**
 * Terminator boot configuration (step 5 — the SSH front door). Same law as
 * the manager's and parkd's loaders: a SET but unparsable value throws at
 * boot, never a silent fallback — the terminator is the platform's only
 * public listener, and a mis-fenced knob nobody notices is exactly the
 * failure mode it must never have.
 */
/**
 * The substrate arm the boot wires — a discriminated union so each arm's
 * required knobs stay fail-loud for that arm ONLY, and neither arm ever
 * sees the other's vocabulary.
 */
export type TerminatorBackendConfig =
  | {
      kind: "kube";
      /** Manager base URL for the session broker (/v1/ssh-sessions). */
      managerUrl: string;
      /** Terminator↔broker secret — its OWN channel, never the runner secret. */
      brokerToken: string | null;
      /** Secrets Manager ARN of the broker secret (cloud). */
      brokerSecretArn: string | null;
      /**
       * API-server CA bundle path. The pod runs automountServiceAccountToken:
       * false (zero standing credential), so the chart mounts the kube-root-ca
       * ConfigMap as a plain volume — this file is the only TLS trust source.
       */
      kubeCaFile: string;
      /**
       * `https://host:port` of the API server, from the injected
       * KUBERNETES_SERVICE_HOST/PORT env (present regardless of automount).
       * Null outside a cluster — the boot fails loud, tests inject fakes.
       */
      kubeServer: string | null;
    }
  | {
      kind: "docker";
      /** The daemon socket — the substrate's whole address. */
      socketPath: string;
    };

export interface TerminatorConfig {
  /** The ssh2 listener's port (NLB target). */
  port: number;
  /** Plain-HTTP health listener (NLB health checks; never internet-facing). */
  healthPort: number;
  /** Host private key provided directly (tests, dev). */
  hostKey: string | null;
  /** Secrets Manager ARN of the host key (cloud; workflow-minted). */
  hostKeySecretArn: string | null;
  /** The CA trust anchor, parsed from an authorized_keys line to raw 32B. */
  caPublicKey: Buffer;
  /** Control-plane base URL for the terminator surface (/v1/ssh-terminator). */
  controlPlaneUrl: string;
  /** Terminator↔control-plane secret, provided directly (tests, dev). */
  controlPlaneToken: string | null;
  /** Secrets Manager ARN of that secret (cloud). */
  controlPlaneSecretArn: string | null;
  /** The selected substrate arm and its knobs. */
  backend: TerminatorBackendConfig;
  /** How long a session holds open waiting for a sleeping agent to wake. */
  wakeWaitSeconds: number;
  /** Global concurrent-connection ceiling. */
  maxSessions: number;
  /** Concurrent-connection ceiling per source IP. */
  maxSessionsPerIp: number;
  /** Pre-auth token bucket: connection attempts per IP per minute. */
  preauthPerIpPerMinute: number;
  /** Sockets not authenticated within this window are destroyed. */
  preauthTimeoutSeconds: number;
  /** CloudWatch namespace — per-env in cloud (dev and prod share one AWS
   * account). Required in cloud mode (host key via ARN): the metrics IAM
   * grant is namespace-conditioned, so a base fallback would silently
   * AccessDeny every publish. Local/test falls back to the base constant. */
  metricNamespace: string;
}

const int = (
  name: string,
  raw: string | undefined,
  fallback: number,
): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}".`);
  }
  return n;
};

export const loadTerminatorConfig = (
  env: NodeJS.ProcessEnv,
): TerminatorConfig => {
  const hostKey = env.TERMINATOR_HOST_KEY?.trim() || null;
  const hostKeySecretArn = env.TERMINATOR_HOST_KEY_SECRET_ARN?.trim() || null;
  if (!hostKey && !hostKeySecretArn) {
    throw new ConfigError(
      "One of TERMINATOR_HOST_KEY or TERMINATOR_HOST_KEY_SECRET_ARN is " +
        "required — an SSH server with no host key cannot handshake.",
    );
  }

  const caLine = env.TERMINATOR_CA_PUBLIC_KEY?.trim();
  if (!caLine) {
    throw new ConfigError(
      "TERMINATOR_CA_PUBLIC_KEY is required — with no trust anchor every " +
        "certificate would be refused (or worse, none would be).",
    );
  }
  let caPublicKey: Buffer;
  try {
    caPublicKey = parseEd25519PublicKeyLine(caLine);
  } catch (error) {
    throw new ConfigError(
      "TERMINATOR_CA_PUBLIC_KEY must be an ssh-ed25519 authorized_keys line: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const controlPlaneUrl = env.TERMINATOR_CONTROL_PLANE_URL?.trim();
  if (!controlPlaneUrl) {
    throw new ConfigError(
      "TERMINATOR_CONTROL_PLANE_URL is required — session-open is the " +
        "access-law gate, and there is no safe default to point it at.",
    );
  }
  const controlPlaneToken = env.TERMINATOR_CONTROL_PLANE_TOKEN?.trim() || null;
  const controlPlaneSecretArn =
    env.TERMINATOR_CONTROL_PLANE_SECRET_ARN?.trim() || null;
  if (!controlPlaneToken && !controlPlaneSecretArn) {
    throw new ConfigError(
      "One of TERMINATOR_CONTROL_PLANE_TOKEN or " +
        "TERMINATOR_CONTROL_PLANE_SECRET_ARN is required — an " +
        "unauthenticatable terminator could never open a session.",
    );
  }

  // Cloud mode (host key via ARN) must name its per-env namespace — see
  // resolveMetricNamespace.
  const metricNamespace = resolveMetricNamespace(
    env.SANDBOX_METRIC_NAMESPACE,
    Boolean(hostKeySecretArn),
  );

  // ── Substrate selection ────────────────────────────────────────────────
  // Explicit TERMINATOR_BACKEND wins; otherwise ANY kube signal — the
  // manager URL, the kubelet-injected service host, or a Secrets Manager
  // host-key ARN — selects the kube arm. The extra signals are the
  // anti-misfence guard: a cloud pod that loses its manager URL must still
  // select kube and hit the fail-loud requirement below, never silently
  // boot a docker arm with no socket (this loader's founding law).
  const explicitBackend = env.TERMINATOR_BACKEND?.trim() || null;
  if (
    explicitBackend !== null &&
    explicitBackend !== "kube" &&
    explicitBackend !== "docker"
  ) {
    throw new ConfigError(
      `TERMINATOR_BACKEND must be "kube" or "docker", got "${explicitBackend}".`,
    );
  }
  const kubeSignal = Boolean(
    env.TERMINATOR_MANAGER_URL?.trim() ||
    env.KUBERNETES_SERVICE_HOST?.trim() ||
    hostKeySecretArn,
  );
  const backendKind = explicitBackend ?? (kubeSignal ? "kube" : "docker");

  let backend: TerminatorBackendConfig;
  if (backendKind === "kube") {
    const managerUrl = env.TERMINATOR_MANAGER_URL?.trim();
    if (!managerUrl) {
      throw new ConfigError(
        "TERMINATOR_MANAGER_URL is required — without the broker no session " +
          "can ever reach a pod.",
      );
    }
    const brokerToken = env.TERMINATOR_BROKER_TOKEN?.trim() || null;
    const brokerSecretArn = env.TERMINATOR_BROKER_SECRET_ARN?.trim() || null;
    if (!brokerToken && !brokerSecretArn) {
      throw new ConfigError(
        "One of TERMINATOR_BROKER_TOKEN or TERMINATOR_BROKER_SECRET_ARN is " +
          "required — the broker channel has its own secret, never the " +
          "runner's or the control plane's.",
      );
    }
    // Injected by kubelet into every pod regardless of automount; absent
    // when running outside a cluster (tests, dev) — the boot layer decides.
    const kubeHost = env.KUBERNETES_SERVICE_HOST?.trim();
    const kubePort = env.KUBERNETES_SERVICE_PORT?.trim();
    const kubeServer =
      kubeHost && kubePort
        ? `https://${kubeHost.includes(":") ? `[${kubeHost}]` : kubeHost}:${kubePort}`
        : null;
    backend = {
      kind: "kube",
      managerUrl,
      brokerToken,
      brokerSecretArn,
      kubeCaFile:
        env.TERMINATOR_KUBE_CA_FILE?.trim() ||
        "/var/run/onecli/kube-root-ca/ca.crt",
      kubeServer,
    };
  } else {
    backend = {
      kind: "docker",
      socketPath:
        env.TERMINATOR_DOCKER_SOCKET?.trim() || "/var/run/docker.sock",
    };
  }

  return {
    port: int("TERMINATOR_PORT", env.TERMINATOR_PORT, 2222),
    healthPort: int("TERMINATOR_HEALTH_PORT", env.TERMINATOR_HEALTH_PORT, 8091),
    hostKey,
    hostKeySecretArn,
    caPublicKey,
    controlPlaneUrl,
    controlPlaneToken,
    controlPlaneSecretArn,
    backend,
    wakeWaitSeconds: int(
      "TERMINATOR_WAKE_WAIT_SECONDS",
      env.TERMINATOR_WAKE_WAIT_SECONDS,
      180,
    ),
    maxSessions: int(
      "TERMINATOR_MAX_SESSIONS",
      env.TERMINATOR_MAX_SESSIONS,
      256,
    ),
    maxSessionsPerIp: int(
      "TERMINATOR_MAX_SESSIONS_PER_IP",
      env.TERMINATOR_MAX_SESSIONS_PER_IP,
      8,
    ),
    preauthPerIpPerMinute: int(
      "TERMINATOR_PREAUTH_PER_IP_PER_MINUTE",
      env.TERMINATOR_PREAUTH_PER_IP_PER_MINUTE,
      12,
    ),
    preauthTimeoutSeconds: int(
      "TERMINATOR_PREAUTH_TIMEOUT_SECONDS",
      env.TERMINATOR_PREAUTH_TIMEOUT_SECONDS,
      30,
    ),
    metricNamespace,
  };
};
