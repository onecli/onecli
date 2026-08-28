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
   * The `cloud` backend's sandbox-manager endpoint + shared service secret
   * (plans/sandbox-platform.md step 3). No defaults, and required only when
   * RUNNER_BACKEND=cloud — every other backend must not even be asked to
   * carry them. Checked at boot so a missing value is one clear line, not a
   * stream of 401s.
   */
  sandboxManagerUrl: string | null;
  sandboxManagerToken: string | null;
  /**
   * Ceiling on waiting for the manager to ACCEPT a park (the parker job
   * created — never the upload itself, which completes manager-side): bounds
   * the predecessor pod's 30s termination grace plus slack.
   */
  cloudParkWaitSeconds: number;
  /**
   * Ceiling on waking a home: a wake may pay a still-finishing park, a
   * fresh node provision (~2 min) and a full restore stream.
   */
  cloudWakeWaitSeconds: number;
  /**
   * How long a create watches the new sandbox for an image-pull refusal
   * (the cloud analogue of Docker's synchronous pull failure).
   */
  cloudImageWaitSeconds: number;
  /**
   * How many sandbox STARTS may execute concurrently (step 4). Default 1
   * keeps backend-touching work globally serialized — docker operations on
   * one self-host box contend, and a burst of parallel image pulls is how a
   * laptop falls over. The cloud deployment raises it: there each start is a
   * remote Kubernetes operation (a wake can legitimately hold for minutes),
   * and serializing them head-of-line-blocks every other sandbox. Stops are
   * never gated on this — they are cheap everywhere, and a stop stuck in a
   * queue past the control plane's 300s stale-claim window is re-dispatched
   * as a spurious START (the storm feedback loop).
   */
  lifecycleConcurrency: number;
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
    lifecycleConcurrency: int(env.RUNNER_LIFECYCLE_CONCURRENCY, 1),
  };
};
