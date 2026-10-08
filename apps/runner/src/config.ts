/**
 * Runner configuration. Every address is configuration with a LOCAL default
 * (plans/hosted-agents-v2.md §3.14 rule 3) — the identical binary points at a
 * remote control plane by changing one env var, which is what keeps "deploy
 * elsewhere later" a config change rather than a re-architecture.
 */

export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
}

export interface RunnerConfig {
  /** The runner's credential AND its registration anchor (§5.1). */
  token: string;
  controlPlaneUrl: string;
  name: string;
  /** Backend id — CONFIG, never detection. The composition root maps it. */
  backend: string;
  agentImage: string;
  sandboxNetwork: string;
  /** `internal` networks have no route out; the gateway is dual-homed onto
   * them. False only for local dev, where the gateway runs on the host. */
  networkInternal: boolean;
  wsPort: number;
  /** How a sandbox addresses this runner — a container-network name. */
  advertisedHost: string;
  maxSandboxes: number;
  limits: SandboxLimits;
  reconcileSeconds: number;
  dockerSocket: string;
  /**
   * Extra host→target entries for sandbox containers (`host:target`,
   * comma-separated; `host-gateway` targets the docker host). What lets a
   * Linux sandbox resolve `host.docker.internal` when the gateway runs on the
   * host — Docker Desktop provides the name natively, plain Linux does not.
   */
  sandboxExtraHosts: string[];
  /**
   * The stale-label orphan sweep (step 13): reap containers/volumes whose
   * sandbox no longer exists anywhere in the control plane. False = detect
   * and log, delete nothing — the operator kill-switch.
   */
  orphanReap: boolean;
  /** Minimum age before a stale-label object may be reaped. */
  orphanGraceSeconds: number;
  /**
   * The `cloud` backend's remote endpoint + shared service secret. No
   * defaults, and required only when
   * RUNNER_BACKEND=cloud — every other backend must not even be asked to
   * carry them. Checked at boot so a missing value is one clear line, not a
   * stream of 401s.
   */
  sandboxManagerUrl: string | null;
  sandboxManagerToken: string | null;
  /**
   * Ceiling on waiting for the backend to ACCEPT a park (never the archive
   * itself, which completes backend-side): bounds the predecessor
   * sandbox's termination grace plus slack.
   */
  cloudParkWaitSeconds: number;
  /**
   * Ceiling on waking a home: a wake may pay a still-finishing park, fresh
   * capacity coming up, and a full restore.
   */
  cloudWakeWaitSeconds: number;
  /**
   * How long a create watches the new sandbox for an image-pull refusal
   * (the remote analogue of Docker's synchronous pull failure).
   */
  cloudImageWaitSeconds: number;
  /**
   * How many sandbox STARTS may execute concurrently. Default 1
   * keeps backend-touching work globally serialized — docker operations on
   * one self-host box contend, and a burst of parallel image pulls is how a
   * laptop falls over. A remote backend raises it: there each start is a
   * remote operation (a wake can legitimately hold for minutes),
   * and serializing them head-of-line-blocks every other sandbox. Stops are
   * never gated on this — they are cheap everywhere, and a stop stuck in a
   * queue past the control plane's 300s stale-claim window is re-dispatched
   * as a spurious START (the storm feedback loop).
   */
  lifecycleConcurrency: number;
  /**
   * The `kubernetes` backend's settings. Every address is a Service name in
   * the release namespace (the chart wires them), and the sandbox namespace
   * is where the Jobs/PVCs/Secrets land. Only read (and only validated) when
   * RUNNER_BACKEND=kubernetes, which is why it is optional on the type: the
   * docker and cloud arms, and every test fixture for them, never carry it.
   */
  kube?: {
    namespace: string;
    controlNamespace: string | null;
    gatewayService: string;
    gatewayPort: number;
    /** The hostname sandboxes address the gateway by. MUST equal the host
     * part of the api's ONECLI_AGENT_PROXY_ADDRESS, since that is the name
     * inside every HTTPS_PROXY the control plane hands out. */
    gatewayHost: string;
    runnerService: string;
    apiService: string;
    apiPort: number;
    storageClass: string | null;
    homeSize: string;
    /** Per-pod cap on node-local scratch (`ephemeral-storage` limit);
     * null leaves it to the namespace's LimitRange, if any. */
    ephemeralStorageLimit: string | null;
    nodeSelector: Record<string, string>;
    tolerations: unknown[];
    runtimeClassName: string | null;
    imagePullSecrets: string[];
  };
}

const int = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  // Integer, not merely finite: a fractional port or pid limit is a
  // configuration mistake that should fall back, not reach the daemon.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const bool = (raw: string | undefined, fallback: boolean): boolean =>
  raw === undefined || raw === "" ? fallback : raw !== "false" && raw !== "0";

export class ConfigError extends Error {}

/** `key=value,key2=value2` → a map; empty input → empty map. */
const parseKeyValues = (raw: string | undefined): Record<string, string> =>
  Object.fromEntries(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const index = entry.indexOf("=");
        return index === -1
          ? [entry, ""]
          : [entry.slice(0, index), entry.slice(index + 1)];
      }),
  );

/** A JSON array of toleration objects, or empty. Malformed input is a
 * configuration error, never silently ignored. */
const parseTolerations = (raw: string | undefined): unknown[] => {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("RUNNER_KUBE_TOLERATIONS must be a JSON array.");
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError("RUNNER_KUBE_TOLERATIONS must be a JSON array.");
  }
  return parsed;
};

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
): RunnerConfig => {
  const token = env.RUNNER_TOKEN ?? "";
  if (!token) {
    throw new ConfigError(
      "RUNNER_TOKEN is required — the runner cannot register or authenticate without it.",
    );
  }
  // Checked here so a mistyped token fails at boot with a clear message,
  // rather than as an endless stream of hint-free 401s.
  if (!token.startsWith("rnr_")) {
    throw new ConfigError(
      'RUNNER_TOKEN must start with "rnr_" — the control plane rejects any other shape.',
    );
  }

  const backend = env.RUNNER_BACKEND ?? "docker";
  const sandboxManagerUrl = env.RUNNER_SANDBOX_MANAGER_URL?.trim() || null;
  const sandboxManagerToken = env.RUNNER_SANDBOX_MANAGER_TOKEN?.trim() || null;
  if (backend === "cloud" && (!sandboxManagerUrl || !sandboxManagerToken)) {
    throw new ConfigError(
      'RUNNER_BACKEND="cloud" requires RUNNER_SANDBOX_MANAGER_URL and ' +
        "RUNNER_SANDBOX_MANAGER_TOKEN — the cloud backend cannot reach its " +
        "sandbox-manager without them.",
    );
  }
  const kubeNamespace = env.RUNNER_KUBE_NAMESPACE?.trim() || "";
  if (backend === "kubernetes" && !kubeNamespace) {
    throw new ConfigError(
      'RUNNER_BACKEND="kubernetes" requires RUNNER_KUBE_NAMESPACE, the ' +
        "namespace sandboxes are created in.",
    );
  }

  return {
    token,
    controlPlaneUrl: env.RUNNER_CONTROL_PLANE_URL ?? "http://localhost:10256",
    name: env.RUNNER_NAME ?? "runner",
    backend,
    agentImage: env.RUNNER_AGENT_IMAGE ?? "onecli-agent:dev",
    sandboxNetwork: env.RUNNER_SANDBOX_NETWORK ?? "onecli-sandboxes",
    networkInternal: bool(env.RUNNER_NETWORK_INTERNAL, true),
    wsPort: int(env.RUNNER_WS_PORT, 8484),
    advertisedHost: env.RUNNER_ADVERTISED_HOST ?? "runner",
    maxSandboxes: int(env.RUNNER_MAX_SANDBOXES, 4),
    limits: {
      memoryMb: int(env.RUNNER_SANDBOX_MEMORY_MB, 2048),
      // Default 1 (shared code — the docker backend maps this to a hard
      // `--cpus` cap, and a 1-vCPU self-host must be able to create sandboxes).
      // Cloud sizes the ceiling up explicitly via RUNNER_SANDBOX_CPUS in the
      // runner construct, where the Burstable request/limit split makes a higher
      // ceiling free for packing.
      cpus:
        Number(env.RUNNER_SANDBOX_CPUS) > 0
          ? Number(env.RUNNER_SANDBOX_CPUS)
          : 1,
      pids: int(env.RUNNER_SANDBOX_PIDS, 512),
    },
    reconcileSeconds: int(env.RUNNER_RECONCILE_SECONDS, 60),
    dockerSocket: env.RUNNER_DOCKER_SOCKET ?? "/var/run/docker.sock",
    sandboxExtraHosts: (env.RUNNER_SANDBOX_EXTRA_HOSTS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    orphanReap: bool(env.RUNNER_ORPHAN_REAP, true),
    orphanGraceSeconds: int(env.RUNNER_ORPHAN_GRACE_SECONDS, 3600),
    sandboxManagerUrl,
    sandboxManagerToken,
    cloudParkWaitSeconds: int(env.RUNNER_CLOUD_PARK_WAIT_SECONDS, 120),
    cloudWakeWaitSeconds: int(env.RUNNER_CLOUD_WAKE_WAIT_SECONDS, 900),
    cloudImageWaitSeconds: int(env.RUNNER_CLOUD_IMAGE_WAIT_SECONDS, 240),
    // The kubernetes backend's starts are remote operations like the cloud
    // arm's, so the default serialization that protects a single Docker
    // host would only head-of-line-block them here.
    lifecycleConcurrency: int(
      env.RUNNER_LIFECYCLE_CONCURRENCY,
      backend === "kubernetes" ? 4 : 1,
    ),
    kube: {
      namespace: kubeNamespace,
      controlNamespace: env.RUNNER_KUBE_CONTROL_NAMESPACE?.trim() || null,
      gatewayService:
        env.RUNNER_KUBE_GATEWAY_SERVICE?.trim() || "onecli-gateway",
      gatewayPort: int(env.RUNNER_KUBE_GATEWAY_PORT, 10255),
      gatewayHost:
        env.RUNNER_KUBE_GATEWAY_HOST?.trim() ||
        env.RUNNER_KUBE_GATEWAY_SERVICE?.trim() ||
        "onecli-gateway",
      runnerService: env.RUNNER_KUBE_RUNNER_SERVICE?.trim() || "onecli-runner",
      apiService: env.RUNNER_KUBE_API_SERVICE?.trim() || "onecli-api",
      apiPort: int(env.RUNNER_KUBE_API_PORT, 10256),
      storageClass: env.RUNNER_KUBE_STORAGE_CLASS?.trim() || null,
      homeSize: env.RUNNER_KUBE_HOME_SIZE?.trim() || "20Gi",
      ephemeralStorageLimit:
        env.RUNNER_KUBE_EPHEMERAL_STORAGE_LIMIT?.trim() || null,
      nodeSelector: parseKeyValues(env.RUNNER_KUBE_NODE_SELECTOR),
      tolerations: parseTolerations(env.RUNNER_KUBE_TOLERATIONS),
      runtimeClassName: env.RUNNER_KUBE_RUNTIME_CLASS?.trim() || null,
      imagePullSecrets: list(env.RUNNER_KUBE_IMAGE_PULL_SECRETS),
    },
  };
};
