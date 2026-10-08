import { randomBytes } from "node:crypto";
import {
  ImageUnavailableError,
  type HomeRef,
  type ManagedObject,
  type SandboxBackend,
  type SandboxSnapshot,
  type SandboxSpec,
} from "../types";
import { labelSelector, type KubeClient } from "./kube-client";
import { log } from "../../log";

/**
 * The Kubernetes sandbox backend: one Job + PVC + Secret per sandbox in a
 * dedicated namespace, for self-hosters whose compute is a cluster rather
 * than a Docker host. Same isolation class as the Docker backend (an
 * unprivileged container on a shared kernel), the same zero-credential
 * payload, the same hardening triple expressed in pod-spec terms.
 *
 * Two properties do the security work, both living here:
 *
 * 1. **The namespace is the egress boundary.** A default-deny NetworkPolicy
 *    (shipped by the chart, not by this code) allows a sandbox to reach only
 *    the gateway and the runner. Enforcement lives in the CNI, below anything
 *    the agent can touch. But CNIs enrol a new pod's IP asynchronously, so a
 *    freshly started pod can have an unfenced window of a second or two
 *    (measured, not theoretical). Every sandbox therefore starts with a
 *    platform-owned init container that waits until an in-cluster target it
 *    must NOT reach is actually denied, and refuses to hand over to the
 *    workload otherwise. A cluster with no policy enforcement never starts a
 *    sandbox at all. It fails closed, like the Docker arm's non-internal-network
 *    refusal.
 * 2. **Nothing but the home volume is mounted**, plus the read-only per-spawn
 *    Secret the payload files are installed from. No ServiceAccount token
 *    (automount off), no hostPath, no socket.
 *
 * Every wake is a NEW pod on the same PVC: the control channel's bootstrap
 * token is single-use and rides the pod's environment, so an old pod can
 * never re-authenticate. Jobs are created with backoffLimit 0 and
 * restartPolicy Never, so Kubernetes never restarts a sandbox on its own; the
 * runner owns the lifecycle exactly as it does on Docker.
 */

/** The label keys the Docker backend uses, kept byte-identical so the api,
 * the ssh-terminator and the orphan sweep filter the same way on every
 * substrate. */
export const LABEL_MANAGED = "sh.onecli.managed";
export const LABEL_SANDBOX = "sh.onecli.sandbox-id";
export const LABEL_RUNNER = "sh.onecli.runner-id";
export const LABEL_INSTALLATION = "sh.onecli.installation";
export const LABEL_SPAWN = "sh.onecli.spawn";
/** The payload hash is a 64-char sha256 hex digest, one past the label
 * value cap, so it rides an annotation. */
export const ANNOTATION_PAYLOAD = "sh.onecli.payload-hash";
/** The human-readable role label, the NetworkPolicy's selector. */
export const LABEL_ROLE = "onecli.sh/role";
export const ROLE_SANDBOX = "sandbox";

const JOB_PREFIX = "onecli-sandbox-";
const HOME_PREFIX = "onecli-home-";
const HOME_MOUNT = "/workspace";
const INIT_MOUNT = "/onecli-init";

/** The agent image's unprivileged user, by NUMBER (kubelet's runAsNonRoot
 * verification rejects a name). */
const NODE_UID = 1000;
const NODE_GID = 1000;

/** How long a stopping sandbox gets between SIGTERM and SIGKILL (the
 * Docker arm's `stop?t=30`). */
const STOP_GRACE_SECONDS = 30;

/** How long the egress gate waits for the fence before refusing. */
const EGRESS_GATE_TIMEOUT_SECONDS = 30;

/** How long a create watches for an image-pull refusal. */
const IMAGE_WAIT_SECONDS = 240;

const DEFAULT_FILE_MODE = 0o644;

/** Waiting reasons that mean the image cannot be obtained: the async
 * analogue of Docker's synchronous pull failure. */
export const IMAGE_WAITING_REASONS = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "ErrImageNeverPull",
]);

/** Pod phases Kubernetes reports; anything else is "not terminal". */
type PodPhase = "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Injection may not touch the durable home (a prior spawn could pre-plant a
 * symlink on the volume) or the system directories the image's tooling lives
 * in, the same conservative allowlist the Docker backend enforces on the
 * identical payload. `/onecli-init` is this substrate's own read-only mount.
 */
const FORBIDDEN_PATH_PREFIXES = [
  `${HOME_MOUNT}/`,
  `${INIT_MOUNT}/`,
  "/usr/",
  "/bin/",
  "/sbin/",
  "/proc/",
  "/sys/",
  "/dev/",
  "/etc/",
  "/var/run/",
];

export const assertInjectablePath = (containerPath: string): void => {
  if (
    containerPath.length > 300 ||
    !/^\/[A-Za-z0-9._/-]+$/.test(containerPath)
  ) {
    throw new Error(
      `payload file path is not an absolute, conservative path: ${containerPath}`,
    );
  }
  if (containerPath.split("/").includes("..")) {
    throw new Error(`payload file path contains "..": ${containerPath}`);
  }
  if (
    containerPath === HOME_MOUNT ||
    containerPath === INIT_MOUNT ||
    FORBIDDEN_PATH_PREFIXES.some((prefix) => containerPath.startsWith(prefix))
  ) {
    throw new Error(
      `payload file path targets the durable home or a system directory: ${containerPath}`,
    );
  }
};

/** POSIX single-quote: close, escaped quote, reopen. */
const sq = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The boot wrapper: install every payload file from the Secret mount to its
 * absolute path as the unprivileged user (no root phase exists on this
 * substrate: the container starts as uid 1000 and stays there), then hand
 * off to the image's own entrypoint unchanged. `install -D` creates the
 * parent chain node-owned, which is what the workload needs to write its own
 * config dirs later (the `/home/node/.codex` case).
 */
export const renderBootScript = (
  files: Array<{ secretKey: string; containerPath: string; mode: number }>,
): string => {
  const lines = ["set -eu"];
  for (const file of files) {
    const mode = (file.mode & 0o777).toString(8).padStart(4, "0");
    lines.push(
      `install -D -m ${mode} ${sq(`${INIT_MOUNT}/${file.secretKey}`)} ${sq(file.containerPath)}`,
    );
  }
  lines.push("cd /app", 'exec "$@"');
  return `${lines.join("\n")}\n`;
};

/**
 * The egress gate, run as an init container from the agent image itself (it
 * has curl, so no extra image is pulled). Two probes, both required:
 *
 *   - NEGATIVE: a target the fence must deny (the api Service) is refused
 *     (curl 7) or times out (28). Any HTTP answer means the fence is not
 *     enforced yet.
 *   - POSITIVE: a target the fence must allow (the runner's /healthz, through
 *     the same hostAlias the workload will use) answers. Without it, "the api
 *     is unreachable" could equally mean the api is down or the pod has no
 *     network at all, and a sandbox would start on a dead network reading as
 *     a fenced one.
 *
 * Exits 0 the moment both hold, exits 1 after the timeout.
 */
export const renderEgressGate = (timeoutSeconds: number): string =>
  [
    "set -u",
    `i=0; while [ "$i" -lt ${timeoutSeconds * 2} ]; do`,
    '  curl -s -o /dev/null --connect-timeout 1 --max-time 1 "http://$ONECLI_EGRESS_GATE_DENY/" >/dev/null 2>&1; deny=$?',
    '  curl -s -o /dev/null --connect-timeout 1 --max-time 2 "http://$ONECLI_EGRESS_GATE_ALLOW/healthz" >/dev/null 2>&1; allow=$?',
    '  if [ "$allow" -eq 0 ]; then case "$deny" in 7|28) echo "egress gate: fence active after $((i/2))s"; exit 0;; esac; fi',
    "  i=$((i+1)); sleep 0.5",
    "done",
    `echo "egress gate: after ${timeoutSeconds}s the sandbox network policy is not enforced (deny probe rc=$deny) or the runner is unreachable (allow probe rc=$allow); refusing to start the agent" >&2`,
    "exit 1",
    "",
  ].join("\n");

export interface KubernetesBackendOptions {
  /** Initial owner label; replaced by `identify()` once registration
   * returns the stable control-plane id. */
  runnerId: string;
  /** This installation's fingerprint, stamped on every object. */
  installationId: string;
  /** The namespace sandboxes live in (the chart's `sandboxes.namespace`). */
  namespace: string;
  /** The release namespace, where the gateway/api/runner Services live. */
  controlNamespace: string;
  /** Service names resolved at prepare() for hostAliases + the gate target. */
  gatewayService: string;
  gatewayPort: number;
  runnerService: string;
  runnerPort: number;
  apiService: string;
  apiPort: number;
  /** The hostnames sandboxes are told to use for those two destinations,
   * injected into /etc/hosts, so the namespace needs no DNS at all. */
  gatewayHost: string;
  runnerHost: string;
  /** Home PVC sizing. */
  storageClass: string | null;
  homeSize: string;
  /** Cap on the pod's writable node-local scratch (`/tmp`, image layers'
   * upper dir): a runaway install must fill a per-pod budget, never the
   * node's disk. The home PVC is separate and unaffected. */
  ephemeralStorageLimit: string | null;
  /** Scheduling knobs, pass-through. */
  nodeSelector: Record<string, string>;
  tolerations: unknown[];
  runtimeClassName: string | null;
  imagePullSecrets: string[];
  /** The gate's patience; shorter in tests. */
  egressGateTimeoutSeconds?: number;
  /** How long a create watches the new pod for an image-pull refusal before
   * returning optimistically (the supervisor connecting is the real success
   * signal). Shorter in tests. */
  imageWaitSeconds?: number;
  /** Poll cadence for that watch, injectable so tests run in milliseconds. */
  pollIntervalMs?: number;
  client: KubeClient;
}

export const createKubernetesBackend = (
  options: KubernetesBackendOptions,
): SandboxBackend => {
  const { client } = options;
  const ns = options.namespace;
  const gateTimeout =
    options.egressGateTimeoutSeconds ?? EGRESS_GATE_TIMEOUT_SECONDS;
  const imageWaitMs = (options.imageWaitSeconds ?? IMAGE_WAIT_SECONDS) * 1000;
  const pollMs = options.pollIntervalMs ?? 2_000;

  let owner = options.runnerId;
  /** ClusterIPs resolved once at prepare(); hostAliases are immutable per pod
   * anyway, and Service ClusterIPs are stable for the Service's lifetime. */
  let gatewayIp: string | null = null;
  let runnerIp: string | null = null;
  let apiIp: string | null = null;

  const jobsPath = `/apis/batch/v1/namespaces/${ns}/jobs`;
  const podsPath = `/api/v1/namespaces/${ns}/pods`;
  const pvcsPath = `/api/v1/namespaces/${ns}/persistentvolumeclaims`;
  const secretsPath = `/api/v1/namespaces/${ns}/secrets`;

  const ownedSelector = () =>
    labelSelector({ [LABEL_MANAGED]: "1", [LABEL_RUNNER]: owner });
  const managedSelector = () => labelSelector({ [LABEL_MANAGED]: "1" });

  const homeName = (sandboxId: string) => `${HOME_PREFIX}${sandboxId}`;
  const jobName = (sandboxId: string, spawn: string) =>
    `${JOB_PREFIX}${sandboxId}-${spawn}`;

  /** Remove a spawn's Job (foreground, so its pod is gone on return) and
   * the Secret that carried its payload. Both tolerate absence. */
  const removeSpawn = async (name: string): Promise<void> => {
    await client.delete(`${jobsPath}/${encodeURIComponent(name)}`, {
      propagation: "Foreground",
    });
    await client.delete(`${secretsPath}/${encodeURIComponent(name)}`, {
      propagation: "Background",
    });
  };

  const resolveClusterIp = async (
    namespace: string,
    service: string,
  ): Promise<string> => {
    const object = (await client.get(
      `/api/v1/namespaces/${namespace}/services/${service}`,
    )) as { spec?: { clusterIP?: string } } | null;
    const ip = object?.spec?.clusterIP;
    if (!ip || ip === "None") {
      throw new Error(
        `Service ${namespace}/${service} has no ClusterIP; the kubernetes backend needs a routable address for it`,
      );
    }
    return ip;
  };

  /** Where a sandbox's pod lives, by the Job's spawn label. */
  const findPod = async (
    sandboxId: string,
  ): Promise<{
    name: string;
    phase: PodPhase | null;
    waitingReason: string | null;
    jobName: string | null;
  } | null> => {
    const list = (await client.get(
      `${podsPath}?labelSelector=${labelSelector({
        [LABEL_MANAGED]: "1",
        [LABEL_SANDBOX]: sandboxId,
      })}`,
    )) as {
      items?: Array<{
        metadata?: { name?: string; labels?: Record<string, string> };
        status?: {
          phase?: PodPhase;
          containerStatuses?: Array<{
            state?: { waiting?: { reason?: string } };
          }>;
          initContainerStatuses?: Array<{
            state?: { waiting?: { reason?: string } };
          }>;
        };
      }>;
    } | null;
    const pod = list?.items?.[0];
    if (!pod?.metadata?.name) return null;
    // Both lists: a pull failure on the init container surfaces THERE while
    // the main container merely waits with `PodInitializing`, so the first
    // image-shaped reason anywhere wins over a bland one.
    const reasons = [
      ...(pod.status?.initContainerStatuses ?? []),
      ...(pod.status?.containerStatuses ?? []),
    ].flatMap((status) => {
      const reason = status.state?.waiting?.reason;
      return reason ? [reason] : [];
    });
    const waiting =
      reasons.find((reason) => IMAGE_WAITING_REASONS.has(reason)) ??
      reasons[0] ??
      null;
    const spawn = pod.metadata.labels?.[LABEL_SPAWN];
    return {
      name: pod.metadata.name,
      phase: pod.status?.phase ?? null,
      waitingReason: waiting,
      jobName: spawn ? jobName(sandboxId, spawn) : null,
    };
  };

  return {
    id: "kubernetes",
    homeDurability: "resident",

    identify(runnerId: string) {
      owner = runnerId;
    },

    async prepare() {
      await client.version();
      [gatewayIp, runnerIp, apiIp] = await Promise.all([
        resolveClusterIp(options.controlNamespace, options.gatewayService),
        resolveClusterIp(options.controlNamespace, options.runnerService),
        resolveClusterIp(options.controlNamespace, options.apiService),
      ]);
      log("info", "kubernetes backend ready", {
        namespace: ns,
        gateway: `${options.gatewayHost} -> ${gatewayIp}:${options.gatewayPort}`,
        runner: `${options.runnerHost} -> ${runnerIp}:${options.runnerPort}`,
      });
    },

    homeRefFor: homeName,

    // An ensure: a 409 means the claim already exists, which is the desired
    // end state (the engine's "create existing volume returns it" shape).
    async provisionHome(sandboxId) {
      const name = homeName(sandboxId);
      await client.post(
        pvcsPath,
        {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: {
            name,
            labels: {
              [LABEL_MANAGED]: "1",
              [LABEL_SANDBOX]: sandboxId,
              [LABEL_RUNNER]: owner,
              [LABEL_INSTALLATION]: options.installationId,
              [LABEL_ROLE]: ROLE_SANDBOX,
            },
          },
          spec: {
            accessModes: ["ReadWriteOnce"],
            ...(options.storageClass && {
              storageClassName: options.storageClass,
            }),
            resources: { requests: { storage: options.homeSize } },
          },
        },
        { tolerate: [409] },
      );
      return name;
    },

    async destroyHome(ref: HomeRef) {
      await client.delete(`${pvcsPath}/${encodeURIComponent(ref)}`, {
        propagation: "Background",
      });
    },

    // Resident: parking is the pod going away, the claim simply stays.
    async parkHome() {},
    async wakeHome() {},

    async listHomes() {
      const list = (await client.get(
        `${pvcsPath}?labelSelector=${ownedSelector()}`,
      )) as {
        items?: Array<{
          metadata?: { name?: string; labels?: Record<string, string> };
        }>;
      } | null;
      return (list?.items ?? []).flatMap((pvc) => {
        const sandboxId = pvc.metadata?.labels?.[LABEL_SANDBOX];
        const name = pvc.metadata?.name;
        return sandboxId && name ? [{ sandboxId, ref: name }] : [];
      });
    },

    async createSandbox(spec: SandboxSpec) {
      if (!gatewayIp || !runnerIp || !apiIp) {
        throw new Error("kubernetes backend used before prepare()");
      }
      for (const file of spec.files) assertInjectablePath(file.containerPath);

      const spawn = randomBytes(3).toString("hex");
      const name = jobName(spec.sandboxId, spawn);
      const labels = {
        [LABEL_MANAGED]: "1",
        [LABEL_SANDBOX]: spec.sandboxId,
        [LABEL_RUNNER]: owner,
        [LABEL_INSTALLATION]: options.installationId,
        [LABEL_SPAWN]: spawn,
        [LABEL_ROLE]: ROLE_SANDBOX,
      };
      const annotations = { [ANNOTATION_PAYLOAD]: spec.payloadHash };

      const files = spec.files.map((file, index) => ({
        secretKey: `file-${index}`,
        containerPath: file.containerPath,
        mode: file.mode ?? DEFAULT_FILE_MODE,
      }));

      // ONE Secret per spawn carries both halves of the payload: the files
      // (as keys) and the token-bearing environment (envFrom), so neither
      // ever appears in the Job spec that `kubectl get -o yaml` prints.
      await client.post(secretsPath, {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name, labels },
        stringData: {
          "boot.sh": renderBootScript(files),
          "egress-gate.sh": renderEgressGate(gateTimeout),
          ...Object.fromEntries(
            spec.files.map((file, index) => [`file-${index}`, file.content]),
          ),
          ...Object.fromEntries(
            Object.entries(spec.env).map(([key, value]) => [
              `env-${key}`,
              value,
            ]),
          ),
        },
      });

      const job = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name, labels, annotations },
        spec: {
          // Never restarted by Kubernetes: the lifecycle is the runner's.
          backoffLimit: 0,
          completions: 1,
          parallelism: 1,
          template: {
            metadata: { labels, annotations },
            spec: {
              restartPolicy: "Never",
              // Zero-credential invariant applied to Kubernetes itself: a
              // projected SA token in untrusted code is a credential to the
              // cluster.
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              terminationGracePeriodSeconds: STOP_GRACE_SECONDS,
              ...(options.runtimeClassName && {
                runtimeClassName: options.runtimeClassName,
              }),
              ...(Object.keys(options.nodeSelector).length > 0 && {
                nodeSelector: options.nodeSelector,
              }),
              ...(options.tolerations.length > 0 && {
                tolerations: options.tolerations,
              }),
              ...(options.imagePullSecrets.length > 0 && {
                imagePullSecrets: options.imagePullSecrets.map((n) => ({
                  name: n,
                })),
              }),
              // Both platform names with NO resolver: the namespace has no
              // DNS egress, so every name arrives pre-resolved.
              hostAliases: [
                { ip: gatewayIp, hostnames: [options.gatewayHost] },
                { ip: runnerIp, hostnames: [options.runnerHost] },
              ],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: NODE_UID,
                runAsGroup: NODE_GID,
                fsGroup: NODE_GID,
                fsGroupChangePolicy: "OnRootMismatch",
                seccompProfile: { type: "RuntimeDefault" },
              },
              volumes: [
                {
                  name: "home",
                  persistentVolumeClaim: { claimName: spec.homeRef },
                },
                {
                  name: "init",
                  secret: { secretName: name, defaultMode: 0o400 },
                },
              ],
              initContainers: [
                {
                  name: "egress-gate",
                  image: spec.image,
                  command: ["/bin/sh", `${INIT_MOUNT}/egress-gate.sh`],
                  env: [
                    {
                      name: "ONECLI_EGRESS_GATE_DENY",
                      value: `${apiIp}:${options.apiPort}`,
                    },
                    {
                      name: "ONECLI_EGRESS_GATE_ALLOW",
                      value: `${options.runnerHost}:${options.runnerPort}`,
                    },
                  ],
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ["ALL"] },
                  },
                  resources: {
                    requests: { cpu: "10m", memory: "16Mi" },
                    limits: { cpu: "100m", memory: "64Mi" },
                  },
                  volumeMounts: [
                    { name: "init", mountPath: INIT_MOUNT, readOnly: true },
                  ],
                },
              ],
              containers: [
                {
                  name: "sandbox",
                  image: spec.image,
                  // The image's own init (tini) stays PID 1 and forwards
                  // SIGTERM; the wrapper installs the payload and execs the
                  // image's CMD.
                  command: [
                    "/usr/bin/tini",
                    "--",
                    "/bin/sh",
                    `${INIT_MOUNT}/boot.sh`,
                    "./agent-entrypoint.sh",
                  ],
                  env: [
                    ...Object.keys(spec.env).map((key) => ({
                      name: key,
                      valueFrom: { secretKeyRef: { name, key: `env-${key}` } },
                    })),
                    { name: "AGENT_HOME_DIR", value: HOME_MOUNT },
                  ],
                  volumeMounts: [
                    { name: "home", mountPath: HOME_MOUNT },
                    { name: "init", mountPath: INIT_MOUNT, readOnly: true },
                  ],
                  // The hardening triple, in pod-spec terms. No seccomp
                  // weakening, ever: on a shared kernel it is the gate that
                  // keeps rootless podman's userns setup closed.
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ["ALL"] },
                  },
                  // Memory request==limit (not compressible); CPU request is
                  // a quarter of the ceiling so idle agents pack (the cloud
                  // arm's fit law). `limits.pids` has no per-pod field: the
                  // chart's LimitRange + kubelet podPidsLimit cover it.
                  resources: {
                    requests: {
                      memory: `${spec.limits.memoryMb}Mi`,
                      cpu: `${Math.max(250, Math.round(spec.limits.cpus * 250))}m`,
                    },
                    limits: {
                      memory: `${spec.limits.memoryMb}Mi`,
                      cpu: String(spec.limits.cpus),
                      ...(options.ephemeralStorageLimit && {
                        "ephemeral-storage": options.ephemeralStorageLimit,
                      }),
                    },
                  },
                },
              ],
            },
          },
        },
      };

      try {
        await client.post(jobsPath, job);
      } catch (error) {
        // Leave nothing half-spawned: the Secret is this spawn's only debris.
        await client
          .delete(`${secretsPath}/${name}`, { propagation: "Background" })
          .catch(() => undefined);
        throw error;
      }

      // The image watch (the cloud arm's shape): Docker learns "no such
      // image" synchronously; here it arrives minutes later as a pod waiting
      // reason. Watch the fresh pod for a bounded window so a bad image
      // becomes the same typed refusal instead of a sandbox stuck in
      // `starting`. Exit the moment the pod runs; on budget exhaustion return
      // optimistically.
      const deadline = Date.now() + imageWaitMs;
      for (;;) {
        await sleep(pollMs);
        try {
          const pod = await findPod(spec.sandboxId);
          if (pod?.phase === "Running") return name;
          const reason = pod?.waitingReason;
          if (reason && IMAGE_WAITING_REASONS.has(reason)) {
            await removeSpawn(name).catch(() => undefined);
            throw new ImageUnavailableError(spec.image, reason);
          }
        } catch (error) {
          if (error instanceof ImageUnavailableError) throw error;
          // Advisory: the create already succeeded. A blipped poll must
          // never fail a healthy sandbox.
          log("warn", "image watch poll failed", {
            sandboxId: spec.sandboxId,
            error: String(error),
          });
        }
        if (Date.now() > deadline) return name;
      }
    },

    // A Job starts on creation; "start" is the tolerated no-op it is on the
    // cloud arm. An unknown ref is a real error, like Docker's 404.
    async startSandbox(ref) {
      await client.get(`${jobsPath}/${encodeURIComponent(ref)}`);
    },

    // Stop IS remove on this substrate (a Job has no "stopped" state): delete
    // the Job with the grace period the supervisor needs to dispose its
    // harness, then WAIT until the Job is gone. A Foreground delete only
    // marks the object (deletionTimestamp) and returns; the garbage
    // collector removes the pod, then the Job, asynchronously. "Stopped" has
    // to mean the process is dead, so this polls for the 404 (bounded by the
    // grace period plus a margin, after which the kubelet has SIGKILLed).
    async stopSandbox(ref) {
      const path = `${jobsPath}/${encodeURIComponent(ref)}`;
      await client.delete(path, {
        propagation: "Foreground",
        gracePeriodSeconds: STOP_GRACE_SECONDS,
      });
      const deadline = Date.now() + (STOP_GRACE_SECONDS + 30) * 1000;
      while (Date.now() < deadline) {
        const job = await client.get(path, { tolerate: [404] });
        if (job === null) return;
        await sleep(pollMs);
      }
      log("warn", "job still present after the stop grace period", { ref });
    },

    async removeSandbox(ref) {
      await removeSpawn(ref);
    },

    async listSandboxes(): Promise<SandboxSnapshot[]> {
      const list = (await client.get(
        `${jobsPath}?labelSelector=${ownedSelector()}`,
      )) as {
        items?: Array<{
          metadata?: {
            name?: string;
            labels?: Record<string, string>;
            annotations?: Record<string, string>;
            deletionTimestamp?: string;
          };
        }>;
      } | null;

      const snapshots: SandboxSnapshot[] = [];
      for (const job of list?.items ?? []) {
        const sandboxId = job.metadata?.labels?.[LABEL_SANDBOX];
        const name = job.metadata?.name;
        if (!sandboxId || !name || job.metadata?.deletionTimestamp) continue;
        const pod = await findPod(sandboxId);
        snapshots.push({
          sandboxId,
          containerRef: name,
          running: pod?.phase === "Running",
          payloadHash: job.metadata?.annotations?.[ANNOTATION_PAYLOAD] ?? null,
          // A Job whose pod is gone (evicted, node lost) is terminal for the
          // boot-crash classifier: the runner's re-dispatch creates a fresh
          // spawn from the durable home.
          phase: pod?.phase ?? "Failed",
        });
      }
      return snapshots;
    },

    async listManaged(): Promise<ManagedObject[]> {
      const [jobs, pvcs] = await Promise.all([
        client.get(`${jobsPath}?labelSelector=${managedSelector()}`),
        client.get(`${pvcsPath}?labelSelector=${managedSelector()}`),
      ]);
      const toObject = (
        kind: "sandbox" | "home",
        item: {
          metadata?: {
            name?: string;
            labels?: Record<string, string>;
            creationTimestamp?: string;
          };
        },
      ): ManagedObject | null => {
        const name = item.metadata?.name;
        if (!name) return null;
        const createdMs = item.metadata?.creationTimestamp
          ? Date.parse(item.metadata.creationTimestamp)
          : NaN;
        return {
          kind,
          ref: name,
          sandboxId: item.metadata?.labels?.[LABEL_SANDBOX] ?? null,
          runnerId: item.metadata?.labels?.[LABEL_RUNNER] ?? null,
          installationId: item.metadata?.labels?.[LABEL_INSTALLATION] ?? null,
          createdAt: Number.isNaN(createdMs) ? null : new Date(createdMs),
        };
      };
      const jobItems =
        (jobs as { items?: Array<Parameters<typeof toObject>[1]> } | null)
          ?.items ?? [];
      const pvcItems =
        (pvcs as { items?: Array<Parameters<typeof toObject>[1]> } | null)
          ?.items ?? [];
      return [
        ...jobItems.map((j) => toObject("sandbox", j)),
        ...pvcItems.map((p) => toObject("home", p)),
      ].filter((object): object is ManagedObject => object !== null);
    },
  };
};
