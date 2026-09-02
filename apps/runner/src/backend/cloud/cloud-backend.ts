import {
  ImageUnavailableError,
  SandboxCapacityError,
  type ContainerRef,
  type HomeRef,
  type ManagedObject,
  type SandboxBackend,
  type SandboxSnapshot,
  type SandboxSpec,
} from "../types";
import {
  ManagerApiError,
  createManagerClient,
  type ManagerClient,
} from "./manager-client";
import { log } from "../../log";

/**
 * The cloud sandbox backend (plans/sandbox-platform.md step 3): the seam
 * implemented against the sandbox-manager's REST API. The manager owns every
 * Kubernetes mechanic — namespaces, the egress fence, Kata pods, block-device
 * homes — and this backend simply maps the thirteen seam calls onto its
 * resource API, so the runner's lifecycle logic is byte-identical across
 * Docker and cloud.
 *
 * Two semantic differences from Docker, both deliberate:
 *
 * 1. **Stopped sandboxes disappear.** The manager resolves everything through
 *    pods, and a stopped sandbox HAS no pod — so it vanishes from snapshots
 *    instead of lingering as a stopped row. The runner's lifecycle handles
 *    absence on both of its paths: a fresh start provisions from the home,
 *    and reconcile's vanished-pod arm reports a sandbox the control plane
 *    still believes `running` as `stopped` (a pod deleted out-of-band —
 *    node death, eviction — is otherwise indistinguishable from a park).
 * 2. **Homes are `snapshot`-durable (§3.9).** Parking archives the home to
 *    durable storage and frees its node; waking restores it wherever there is
 *    room. Both are manager-side state machines this backend merely polls.
 */

/**
 * Pod waiting reasons that mean the IMAGE cannot be obtained — the cloud
 * analogue of Docker's synchronous pull failure, surfaced asynchronously on
 * the snapshot instead. Anything else waiting (ContainerCreating, node
 * provisioning) is ordinary startup.
 */
const IMAGE_WAITING_REASONS = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "ErrImageNeverPull",
]);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * House codes the manager returns for a DETERMINISTIC refusal — retrying
 * cannot change the answer, whatever the HTTP status carrying it. Keyed on
 * the code, not the status, precisely because status is ambiguous: a 503
 * from the NLB (no healthy backend) is transient and worth retrying, while
 * the manager's own `not_configured` 503 is permanent; a 500 `archive_invalid`
 * is permanent while a 500 `internal` (a kube blip) is not.
 */
const TERMINAL_POLL_CODES = new Set([
  "not_configured",
  "archive_invalid",
  "unexpected_status",
  "bad_home_ref",
]);

/**
 * Whether a poll error is worth retrying inside a bounded loop. The manager
 * redeploys independently of the runner (its own Deployment, its own cadence)
 * and one blipped poll must never abort an operation that was succeeding —
 * so a transport failure (fetch threw / timed out), a truncated body from a
 * dying pod (`bad_body`), and an infra 5xx all retry. A 4xx and the
 * deterministic house refusals above stay terminal — no amount of retrying
 * changes them.
 */
const transientPollError = (error: unknown): boolean => {
  if (!(error instanceof ManagerApiError)) return true;
  if (TERMINAL_POLL_CODES.has(error.code)) return false;
  if (error.code === "bad_body") return true;
  return error.status >= 500;
};

/**
 * The per-workspace ResourceQuota's refusal (step 6): a typed capacity error
 * at the seam, so the runner reports `at_capacity` (honest user copy + the
 * 150s patience window) instead of a generic start failure. BOTH doors that
 * create the home PVC can hit the fence — create (fresh home) and wake (a
 * parked home's PVC is recreated) — so both map through here.
 */
const quotaRefusalAsCapacityError = (error: unknown): unknown =>
  error instanceof ManagerApiError && error.code === "workspace_quota_exceeded"
    ? new SandboxCapacityError(error.message)
    : error;

export interface CloudBackendOptions {
  /** Initial owner label; replaced by `identify()` once registration
   * returns the stable control-plane id. */
  runnerId: string;
  /** This installation's fingerprint — stamped on every object the manager
   * creates for us, so the orphan sweep can fence by install. */
  installationId: string;
  managerUrl: string;
  managerToken: string;
  /** Ceiling on a park being ACCEPTED (parker job created), seconds. */
  parkWaitSeconds: number;
  /** Ceiling on a wake reaching `ready`, seconds. */
  wakeWaitSeconds: number;
  /** How long a create watches for an image-pull refusal, seconds. */
  imageWaitSeconds: number;
  /** Poll cadence — injectable so tests run in milliseconds. */
  pollIntervalMs?: number;
  /** Injectable for tests; the real one is built from url + token. */
  client?: ManagerClient;
}

export const createCloudBackend = (
  options: CloudBackendOptions,
): SandboxBackend => {
  const client =
    options.client ??
    createManagerClient({
      baseUrl: options.managerUrl,
      token: options.managerToken,
    });
  const pollMs = options.pollIntervalMs ?? 2_000;

  // Mutable so registration's stable id replaces the boot-time placeholder
  // before anything is created — see `identify` on the seam.
  let owner = options.runnerId;

  return {
    id: "cloud",
    homeDurability: "snapshot",

    identify(runnerId: string) {
      owner = runnerId;
    },

    async prepare() {
      // Nothing to set up — the manager owns the substrate. A reachability
      // probe would only trade one failure mode for another: the manager
      // redeploys independently of the runner, so refusing to boot while it
      // blips would couple two lifecycles that are deliberately separate.
      // Misconfiguration surfaces loudly on the first call instead.
    },

    async provisionHome(sandboxId) {
      const { ref } = await client.provisionHome(sandboxId);
      return ref;
    },

    async destroyHome(ref: HomeRef) {
      await client.destroyHome(ref);
    },

    /**
     * Park is ACCEPTED, not awaited: the runner executes work items serially,
     * so waiting out a multi-gigabyte upload here would head-of-line-block
     * every other sandbox's lifecycle. `pending` means the manager is still
     * fencing out a terminating pod — poll past it so the parker job
     * genuinely exists before we walk away (nothing else would ever create
     * it); `parking`/`parked` mean the manager owns completion from here.
     */
    async parkHome(ref: HomeRef) {
      const deadline = Date.now() + options.parkWaitSeconds * 1000;
      let lastError: unknown = null;
      for (;;) {
        try {
          const { status } = await client.parkHome(ref);
          if (status === "parking" || status === "parked") return;
          lastError = null;
        } catch (error) {
          // One blipped poll must not fail a park that was proceeding — the
          // manager redeploys independently. Refusals (4xx) stay terminal.
          if (!transientPollError(error)) throw error;
          lastError = error;
          log("warn", "park poll failed; retrying", {
            homeRef: ref,
            error: String(error),
          });
        }
        if (Date.now() > deadline) {
          throw (
            lastError ??
            new Error(
              `park of ${ref} was never accepted within ${options.parkWaitSeconds}s — a predecessor pod is still terminating`,
            )
          );
        }
        await sleep(pollMs);
      }
    },

    /**
     * Wake IS awaited — the caller is about to map the home into a new
     * sandbox, so `ready` is the only acceptable exit. The ceiling is
     * generous by design: a wake may pay a still-finishing park, a fresh
     * node provision, and a full restore stream.
     */
    async wakeHome(ref: HomeRef) {
      const deadline = Date.now() + options.wakeWaitSeconds * 1000;
      let lastNote = "no answer yet";
      for (;;) {
        try {
          const { status } = await client.wakeHome(ref);
          if (status === "ready") return;
          lastNote = `last status: ${status}`;
        } catch (error) {
          // A restore can run for minutes — a single blipped poll at minute
          // fourteen must not throw away the whole wake. Refusals stay
          // terminal; the workspace-quota refusal leaves as the typed
          // capacity error (the wake door recreates the PVC too).
          if (!transientPollError(error)) {
            throw quotaRefusalAsCapacityError(error);
          }
          lastNote = `last poll failed: ${String(error)}`;
          log("warn", "wake poll failed; retrying", {
            homeRef: ref,
            error: String(error),
          });
        }
        if (Date.now() > deadline) {
          throw new Error(
            `home ${ref} did not reach ready within ${options.wakeWaitSeconds}s (${lastNote})`,
          );
        }
        await sleep(pollMs);
      }
    },

    async listHomes() {
      return await client.listHomes(owner);
    },

    async createSandbox(spec: SandboxSpec) {
      // The manager fences every sandbox inside its workspace's namespace —
      // without the id there is nowhere correct to create it, and guessing
      // would cross tenant boundaries. Refuse loudly.
      if (!spec.workspaceId) {
        throw new Error(
          "sandbox.start payload carries no workspaceId — the control plane " +
            "predates workspace-scoped sandboxes; upgrade it before using the " +
            "cloud backend",
        );
      }

      const { containerRef } = await client
        .createSandbox({
          sandboxId: spec.sandboxId,
          workspaceId: spec.workspaceId,
          runnerId: owner,
          installationId: options.installationId,
          image: spec.image,
          env: spec.env,
          files: spec.files.map((file) => ({
            containerPath: file.containerPath,
            content: file.content,
            ...(file.mode !== undefined && { mode: file.mode }),
          })),
          homeRef: spec.homeRef,
          limits: spec.limits,
          payloadHash: spec.payloadHash,
        })
        .catch((error: unknown) => {
          throw quotaRefusalAsCapacityError(error);
        });

      /**
       * The image watch — Docker learns "no such image" synchronously from
       * the create; Kubernetes learns it minutes later as a pod waiting
       * reason. Watch the fresh spawn for a bounded window so a bad image
       * becomes the same typed refusal (`image_unavailable`) instead of a
       * sandbox that hangs in `starting` until the stale-claim sweep. Exit
       * the moment the pod runs (the common case is well inside the budget);
       * on budget exhaustion return optimistically — the supervisor
       * connecting is the real success signal.
       */
      const deadline = Date.now() + options.imageWaitSeconds * 1000;
      for (;;) {
        await sleep(pollMs);
        try {
          const snapshot = (await client.listSandboxes(owner)).find(
            (candidate) => candidate.containerRef === containerRef,
          );
          if (snapshot?.running) return containerRef;
          const reason = snapshot?.waitingReason;
          if (reason && IMAGE_WAITING_REASONS.has(reason)) {
            // Leave nothing behind: the spawn can never start, and the next
            // dispatch recreates from the durable home anyway.
            await client
              .removeSandbox(containerRef, spec.sandboxId)
              .catch(() => undefined);
            throw new ImageUnavailableError(spec.image, reason);
          }
        } catch (error) {
          if (error instanceof ImageUnavailableError) throw error;
          // The watch is ADVISORY — the create already succeeded and the
          // supervisor connecting is the real success signal. A blipped poll
          // must never fail a sandbox whose pod is healthy; wait or return.
          log("warn", "image watch poll failed", {
            sandboxId: spec.sandboxId,
            error: String(error),
          });
        }
        if (Date.now() > deadline) return containerRef;
      }
    },

    async startSandbox(ref: ContainerRef) {
      // A pod that exists is started or starting (the manager's tolerated
      // no-op); an unknown ref is a real error, exactly like Docker's 404.
      await client.startSandbox(ref);
    },

    async stopSandbox(ref: ContainerRef, sandboxId?: string) {
      // Stale refs are success manager-side (Docker's tolerated 404/304).
      await client.stopSandbox(ref, sandboxId);
    },

    async removeSandbox(ref: ContainerRef, sandboxId?: string) {
      await client.removeSandbox(ref, sandboxId);
    },

    async listSandboxes(): Promise<SandboxSnapshot[]> {
      const snapshots = await client.listSandboxes(owner);
      return snapshots.map((snapshot) => ({
        sandboxId: snapshot.sandboxId,
        containerRef: snapshot.containerRef,
        running: snapshot.running,
        payloadHash: snapshot.payloadHash,
        phase: snapshot.phase,
      }));
    },

    async listManaged(): Promise<ManagedObject[]> {
      const managed = await client.listManaged();
      return managed.map((object) => {
        const createdMs = object.createdAt ? Date.parse(object.createdAt) : NaN;
        return {
          kind: object.kind,
          ref: object.ref,
          sandboxId: object.sandboxId,
          runnerId: object.runnerId,
          installationId: object.installationId,
          createdAt: Number.isNaN(createdMs) ? null : new Date(createdMs),
        };
      });
    },
  };
};
