import { posix } from "node:path";
import {
  ImageUnavailableError,
  type ContainerRef,
  type ManagedObject,
  type SandboxBackend,
  type SandboxSnapshot,
  type SandboxSpec,
  type HomeRef,
} from "../types";
import {
  DockerEngine,
  DockerEngineError,
  createSocketTransport,
  encodeFilters,
  type EngineTransport,
} from "./engine-client";
import { buildTar, type TarEntry } from "./tar";
import { log } from "../../log";

/**
 * The local-Docker sandbox backend — v2's only implementation of the seam.
 *
 * Two properties do the security work, and both live here rather than in the
 * lifecycle logic above:
 *
 * 1. **The network is the egress boundary** (§3.4). Every sandbox joins one
 *    `internal` network with no route off the host; the gateway is dual-homed
 *    onto it. Env-var proxying is advisory — a compromised agent can unset it
 *    — so the network, not the environment, is what makes "not through the
 *    gateway" impossible.
 * 2. **Nothing but the home volume is mounted.** No docker socket, no
 *    host paths, and above all not the gateway's data directory — that holds
 *    the CA's PRIVATE key, while the sandbox only ever receives the public
 *    certificate as file content.
 */

/** Every object we create is labeled, which is what makes reconcile possible. */
export const LABEL_SANDBOX = "sh.onecli.sandbox-id";
export const LABEL_RUNNER = "sh.onecli.runner-id";
export const LABEL_PAYLOAD = "sh.onecli.payload-hash";
export const LABEL_MANAGED = "sh.onecli.managed";
/** Which installation created it — a hash of the runner token, so the orphan
 * sweep never touches a DIFFERENT install's objects on a shared daemon. */
export const LABEL_INSTALLATION = "sh.onecli.installation";

const VOLUME_PREFIX = "onecli-home-";
const CONTAINER_PREFIX = "onecli-sandbox-";
const HOME_MOUNT = "/workspace";

/**
 * The agent image's unprivileged user, by NUMBER. The create body pins
 * `User: "node"` by name, but tar headers carry numeric ids and the daemon
 * extracts them verbatim — so injected files are owned by whatever is written
 * here. 1000 is the node base image's uid/gid for that user, the same value
 * the cloud boot phase compares against when it installs these same payload
 * files node-owned on the Kata substrate (apps/sandbox-manager/src/boot/
 * boot-script.ts, NODE_UID).
 */
const NODE_UID = 1000;
const NODE_GID = 1000;

/**
 * Injection may not touch the durable home (a PRIOR spawn could pre-plant a
 * symlink on the volume for the daemon's root-driven extraction to follow —
 * it resolves in-container symlinks) or the system directories the image's
 * own tooling lives in (a control-plane bug must not be able to overwrite
 * /usr/local/bin/node in every sandbox). `/onecli-init/` from the cloud list
 * is omitted: that mount does not exist on this substrate.
 */
const FORBIDDEN_PATH_PREFIXES = [
  `${HOME_MOUNT}/`,
  "/usr/",
  "/bin/",
  "/sbin/",
  "/proc/",
  "/sys/",
  "/dev/",
];

/**
 * Refuse a payload file path the injection must never touch — the same
 * conservative allowlist the cloud manager enforces on the identical payload
 * (apps/sandbox-manager/src/validations.ts `containerPathSchema`; not
 * importable, that package is cloud-only): one substrate trust model. The
 * wire schema only enforces a non-empty string, and beyond the shared rules
 * one shape is dangerous specifically HERE: a relative path would spin the
 * ancestor walk forever (`posix.dirname(".") === "."`).
 */
const assertInjectablePath = (containerPath: string): void => {
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
    FORBIDDEN_PATH_PREFIXES.some((prefix) => containerPath.startsWith(prefix))
  ) {
    throw new Error(
      `payload file path targets the durable home or a system directory: ${containerPath}`,
    );
  }
};

export interface DockerBackendOptions {
  /** Initial owner label; replaced by `identify()` once registration
   * returns the stable control-plane id. */
  runnerId: string;
  /** This installation's fingerprint (`installationFingerprint(token)`) —
   * stamped on every object so the orphan sweep can tell a co-located
   * install's objects from this one's dead-runner-id orphans. */
  installationId: string;
  network: string;
  networkInternal: boolean;
  socketPath: string;
  /** `host:target` entries for sandbox /etc/hosts (`host-gateway` = the
   * docker host) — how a plain-Linux sandbox resolves `host.docker.internal`
   * when the gateway runs on the host. Empty = no entries, no change. */
  extraHosts?: string[];
  /** Injectable for tests — the real one talks to the docker socket. */
  transport?: EngineTransport;
}

export const createDockerBackend = (
  options: DockerBackendOptions,
): SandboxBackend => {
  const engine = new DockerEngine(
    options.transport ?? createSocketTransport(options.socketPath),
  );

  // Mutable so registration's stable id replaces the boot-time placeholder
  // before anything is created — see `identify` on the seam.
  let owner = options.runnerId;

  const ownedFilter = () =>
    encodeFilters({ label: [`${LABEL_RUNNER}=${owner}`] });

  const ensureNetwork = async (): Promise<void> => {
    const networks = (await engine.get(
      `/networks?filters=${encodeFilters({ name: [options.network] })}`,
    )) as Array<{ Name: string; Internal: boolean }> | null;

    const existing = networks?.find((n) => n.Name === options.network);
    if (existing) {
      // Fail closed. A network that already exists WITHOUT isolation — left by
      // a dev run with RUNNER_NETWORK_INTERNAL=false, or created by hand —
      // would give every sandbox direct internet egress while the stack looked
      // healthy. The isolation flag is the egress boundary (§3.4), so a
      // mismatch has to stop the runner, not produce a warning nobody reads.
      if (options.networkInternal && !existing.Internal) {
        throw new Error(
          `Network "${options.network}" exists but is NOT internal, so sandboxes on it would have direct internet egress. Remove it (docker network rm ${options.network}) and restart the runner, or set RUNNER_NETWORK_INTERNAL=false deliberately for local development.`,
        );
      }
      if (!options.networkInternal && existing.Internal) {
        log("warn", "sandbox network is internal but isolation was disabled", {
          network: options.network,
        });
      }
      return;
    }

    await engine.post("/networks/create", {
      Name: options.network,
      Driver: "bridge",
      // THE egress boundary (§3.4). `internal` means no route out of the host.
      Internal: options.networkInternal,
      Labels: { [LABEL_MANAGED]: "1" },
    });
    log("info", "created sandbox network", {
      network: options.network,
      internal: options.networkInternal,
    });
  };

  const volumeName = (sandboxId: string) => `${VOLUME_PREFIX}${sandboxId}`;
  const containerName = (sandboxId: string) =>
    `${CONTAINER_PREFIX}${sandboxId}`;

  /**
   * Deepest EXISTING ancestor of `directory`, plus the missing chain from it
   * down to `directory` (root→leaf). `HEAD /archive` is the probe: 200 means
   * the path exists — file OR directory, the endpoint stats either; a file
   * ancestor makes the later PUT fail with the daemon's own 400, which is
   * the right loud outcome for a platform-composed payload — and 404 means
   * missing. The walk breaks unconditionally at "/": a vanished container
   * 404s EVERY path including "/", and `posix.dirname("/") === "/"` would
   * spin forever — falling through lets the PUT surface the real error.
   */
  const resolveExtractionRoot = async (
    ref: ContainerRef,
    directory: string,
  ): Promise<{ root: string; missing: string[] }> => {
    const missing: string[] = [];
    let current = directory;
    while (current !== "/") {
      const status = await engine.head(
        `/containers/${encodeURIComponent(ref)}/archive?path=${encodeURIComponent(current)}`,
        { tolerate: [404] },
      );
      if (status !== 404) break;
      missing.unshift(posix.basename(current));
      current = posix.dirname(current);
    }
    return { root: current, missing };
  };

  const putFiles = async (
    ref: ContainerRef,
    files: SandboxSpec["files"],
  ): Promise<void> => {
    for (const file of files) assertInjectablePath(file.containerPath);

    // Group by directory: docker extracts one archive per target path.
    const byDirectory = new Map<string, SandboxSpec["files"]>();
    for (const file of files) {
      const directory = posix.dirname(file.containerPath);
      byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), file]);
    }

    // Sequential ON PURPOSE: a later group's existence probe must see the
    // directories an earlier group's PUT just created.
    for (const [directory, groupFiles] of byDirectory) {
      const { root, missing } = await resolveExtractionRoot(ref, directory);

      // Directory entries ONLY for the missing chain, never for a directory
      // that already exists: the daemon applies a dir entry's owner/mode to
      // an existing directory too (verified against a real daemon), so a
      // blanket ancestor entry would silently chown system paths. The chain
      // is created node-owned — the workload must be able to write its own
      // config dirs (the cloud boot script does the same with `install -d
      // -o node -g node`, /home/node/.codex being the motivating case).
      const chain = missing.map(
        (_, index): TarEntry => ({
          kind: "directory",
          path: missing.slice(0, index + 1).join("/"),
          mode: 0o755,
          uid: NODE_UID,
          gid: NODE_GID,
        }),
      );
      const prefix = missing.length > 0 ? `${missing.join("/")}/` : "";
      const entries: TarEntry[] = [
        ...chain,
        ...groupFiles.map(
          (file): TarEntry => ({
            kind: "file",
            path: `${prefix}${posix.basename(file.containerPath)}`,
            content: file.content,
            // & 0o777: permission bits only — setuid/setgid/sticky never ride
            // a payload in (the cloud validator caps mode at 0o777 too).
            mode: (file.mode ?? 0o644) & 0o777,
            uid: NODE_UID,
            gid: NODE_GID,
          }),
        ),
      ];

      await engine.put(
        `/containers/${encodeURIComponent(ref)}/archive?path=${encodeURIComponent(root)}&noOverwriteDirNonDir=false`,
        buildTar(entries),
        "application/x-tar",
      );
    }
  };

  return {
    id: "docker",
    homeDurability: "resident",

    identify(runnerId: string) {
      owner = runnerId;
    },

    async prepare() {
      await engine.negotiateVersion();
      await ensureNetwork();
    },

    async provisionHome(sandboxId) {
      const name = volumeName(sandboxId);
      await engine.post("/volumes/create", {
        Name: name,
        Labels: {
          [LABEL_MANAGED]: "1",
          [LABEL_SANDBOX]: sandboxId,
          [LABEL_RUNNER]: owner,
          [LABEL_INSTALLATION]: options.installationId,
        },
      });
      return name;
    },

    async destroyHome(ref: HomeRef) {
      await engine.delete(`/volumes/${encodeURIComponent(ref)}?force=true`, {
        tolerate: [404],
      });
    },

    // `resident` disks are durable on their own — parking is the container
    // stopping, and the volume simply stays (§3.9).
    async parkHome() {},
    async wakeHome() {},

    async listHomes() {
      const volumes = (await engine.get(
        `/volumes?filters=${ownedFilter()}`,
      )) as {
        Volumes?: Array<{ Name: string; Labels?: Record<string, string> }>;
      } | null;

      return (volumes?.Volumes ?? []).flatMap((volume) => {
        const sandboxId = volume.Labels?.[LABEL_SANDBOX];
        return sandboxId ? [{ sandboxId, ref: volume.Name }] : [];
      });
    },

    async createSandbox(spec: SandboxSpec) {
      /**
       * Whether this create failed because the IMAGE is absent — the message
       * test matters: `/containers/create` also answers 404 for a missing
       * network, and pulling would not fix that.
       */
      const imageMissing = (error: unknown): error is DockerEngineError =>
        error instanceof DockerEngineError &&
        error.status === 404 &&
        /no such image/i.test(error.detail);

      const create = async () =>
        (await engine.post(
          `/containers/create?name=${encodeURIComponent(containerName(spec.sandboxId))}`,
          {
            Image: spec.image,
            Env: Object.entries(spec.env).map(
              ([key, value]) => `${key}=${value}`,
            ),
            // Explicit, so an image change can never silently promote the
            // workload to root.
            User: "node",
            Labels: {
              [LABEL_MANAGED]: "1",
              [LABEL_SANDBOX]: spec.sandboxId,
              [LABEL_RUNNER]: owner,
              [LABEL_PAYLOAD]: spec.payloadHash,
              [LABEL_INSTALLATION]: options.installationId,
            },
            HostConfig: {
              // The ONLY mount: the agent's own durable home.
              Binds: [`${spec.homeRef}:${HOME_MOUNT}`],
              NetworkMode: options.network,
              Memory: spec.limits.memoryMb * 1024 * 1024,
              NanoCpus: Math.round(spec.limits.cpus * 1e9),
              PidsLimit: spec.limits.pids,
              // A sandbox runs untrusted model output. It starts as an
              // unprivileged user and must never climb: no new privileges, and
              // no capabilities at all — the harness needs none, and the default
              // set includes NET_RAW, which on a shared sandbox network would
              // let one sandbox spoof its way to another's proxy credentials.
              //
              // These three guards are ALSO the tenant boundary for the podman
              // baked into the agent image: on this SHARED kernel the daemon's
              // default seccomp profile blocks the `unshare`/`clone` namespace
              // syscalls unless CAP_SYS_ADMIN is held, CapDrop:ALL removes that
              // capability, and no-new-privileges neuters the setuid uidmap
              // helpers — so rootless containers cannot set up their user
              // namespace here (they are a hosted-microVM-only capability; see
              // apps/runner/README.md). NEVER add a `seccomp=…` SecurityOpt
              // that weakens the default profile: seccomp is the actual syscall
              // gate, and `seccomp=unconfined` would re-open single-uid rootless
              // podman on the shared kernel. Pinned by the test.
              SecurityOpt: ["no-new-privileges"],
              CapDrop: ["ALL"],
              RestartPolicy: { Name: "no" },
              ...(options.extraHosts &&
                options.extraHosts.length > 0 && {
                  ExtraHosts: options.extraHosts,
                }),
            },
          },
        )) as { Id: string };

      let created: { Id: string };
      try {
        created = await create();
      } catch (error) {
        if (!imageMissing(error)) throw error;
        // The image simply is not on this host yet — the expected state of a
        // clean install. Pull it and retry the create ONCE; a failed pull (or
        // a second miss) becomes the typed refusal the runner classifies as
        // `image_unavailable`. Concurrency: work items execute serially per
        // runner, and `docker pull` is idempotent and concurrent-safe, so a
        // stale-claim re-dispatch overlapping a slow pull just joins it.
        log("info", "agent image absent; pulling", { image: spec.image });
        try {
          await engine.pullImage(spec.image);
        } catch (pullError) {
          throw new ImageUnavailableError(spec.image, String(pullError));
        }
        log("info", "agent image pulled", { image: spec.image });
        try {
          created = await create();
        } catch (retryError) {
          if (imageMissing(retryError)) {
            throw new ImageUnavailableError(spec.image, retryError.detail);
          }
          throw retryError;
        }
      }

      // Files land BEFORE the first start, so the supervisor's very first
      // read already sees the CA (no race, no root phase, no volume
      // side-channel).
      if (spec.files.length > 0) await putFiles(created.Id, spec.files);

      return created.Id;
    },

    async startSandbox(ref) {
      // 304 = already started, which is success for our purposes.
      await engine.post(
        `/containers/${encodeURIComponent(ref)}/start`,
        undefined,
        {
          tolerate: [304],
        },
      );
    },

    async stopSandbox(ref) {
      // Graceful: the supervisor gets 30s to finish and dispose its harness.
      await engine.post(
        `/containers/${encodeURIComponent(ref)}/stop?t=30`,
        undefined,
        {
          tolerate: [304, 404],
        },
      );
    },

    async removeSandbox(ref) {
      try {
        await engine.delete(
          `/containers/${encodeURIComponent(ref)}?force=true`,
          {
            tolerate: [404],
          },
        );
      } catch (error) {
        // A container already gone is the desired end state.
        if (error instanceof DockerEngineError && error.status === 404) return;
        throw error;
      }
    },

    async listSandboxes(): Promise<SandboxSnapshot[]> {
      const containers = (await engine.get(
        `/containers/json?all=true&filters=${ownedFilter()}`,
      )) as Array<{
        Id: string;
        State: string;
        Labels?: Record<string, string>;
      }> | null;

      return (containers ?? []).flatMap((container) => {
        const sandboxId = container.Labels?.[LABEL_SANDBOX];
        if (!sandboxId) return [];
        return [
          {
            sandboxId,
            containerRef: container.Id,
            running: container.State === "running",
            payloadHash: container.Labels?.[LABEL_PAYLOAD] ?? null,
          },
        ];
      });
    },

    async listManaged(): Promise<ManagedObject[]> {
      // EVERY platform-created object, any runner's label — the one list that
      // is deliberately NOT owner-scoped, because stale-label orphans are by
      // definition someone else's label. Networks are never listed: the
      // sandbox network is shared and carries no runner id.
      const managedFilter = encodeFilters({ label: [`${LABEL_MANAGED}=1`] });

      const containers = (await engine.get(
        `/containers/json?all=true&filters=${managedFilter}`,
      )) as Array<{
        Id: string;
        Created?: number;
        Labels?: Record<string, string>;
      }> | null;

      const volumes = (await engine.get(
        `/volumes?filters=${managedFilter}`,
      )) as {
        Volumes?: Array<{
          Name: string;
          CreatedAt?: string;
          Labels?: Record<string, string>;
        }>;
      } | null;

      const containerObjects: ManagedObject[] = (containers ?? []).map(
        (container) => ({
          kind: "sandbox",
          ref: container.Id,
          sandboxId: container.Labels?.[LABEL_SANDBOX] ?? null,
          runnerId: container.Labels?.[LABEL_RUNNER] ?? null,
          installationId: container.Labels?.[LABEL_INSTALLATION] ?? null,
          // `/containers/json` reports Created as unix SECONDS.
          createdAt:
            typeof container.Created === "number"
              ? new Date(container.Created * 1000)
              : null,
        }),
      );

      const volumeObjects: ManagedObject[] = (volumes?.Volumes ?? []).map(
        (volume) => {
          const createdMs = volume.CreatedAt
            ? Date.parse(volume.CreatedAt)
            : NaN;
          return {
            kind: "home",
            ref: volume.Name,
            sandboxId: volume.Labels?.[LABEL_SANDBOX] ?? null,
            runnerId: volume.Labels?.[LABEL_RUNNER] ?? null,
            installationId: volume.Labels?.[LABEL_INSTALLATION] ?? null,
            createdAt: Number.isNaN(createdMs) ? null : new Date(createdMs),
          };
        },
      );

      return [...containerObjects, ...volumeObjects];
    },
  };
};
