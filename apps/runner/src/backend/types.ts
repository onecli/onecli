/**
 * THE SANDBOX BACKEND SEAM (plans/hosted-agents-v2.md §3.14 rule 2, §3.9).
 *
 * The runner's lifecycle logic speaks only this interface. v2 ships local
 * Docker; gVisor, microVMs, Fly, and managed substrates are ADDED backends,
 * never edits to the runner — and the home contract is part of the same
 * interface, so a new substrate brings its own durability implementation
 * behind the same opaque ref.
 *
 * The vocabulary here is deliberately ours: nothing in this file names a
 * container runtime, and no runtime library may be imported outside its own
 * backend directory (the review greps for it, same rule as invariant 9).
 */

/**
 * The backend could not OBTAIN the sandbox image — it is not present where
 * the backend runs and could not be fetched (unknown tag, registry refusal,
 * a download that failed). Typed so the runner can classify the start
 * failure for the control plane (`reasonCode: "image_unavailable"`) without
 * knowing any runtime's error shapes; the vocabulary stays ours.
 */
export class ImageUnavailableError extends Error {
  constructor(
    readonly image: string,
    detail: string,
  ) {
    super(`sandbox image unavailable: ${image} (${detail})`);
    this.name = "ImageUnavailableError";
  }
}

/**
 * The substrate refused the create for CAPACITY — a per-tenant quota or an
 * admission fence, not a broken image or a crashed boot. Typed at the seam
 * (the ImageUnavailableError pattern) so the runner can classify it
 * `reasonCode: "at_capacity"` — the control plane's honest "too many agents
 * are running right now" copy — without knowing any substrate's error
 * shapes. On the cloud backend this carries the manager's 422
 * `workspace_quota_exceeded` (the per-workspace ResourceQuota, step 6).
 */
export class SandboxCapacityError extends Error {
  constructor(detail: string) {
    super(`sandbox refused for capacity: ${detail}`);
    this.name = "SandboxCapacityError";
  }
}

/** Where a home lives, as far as anything above the backend knows. */
export type HomeRef = string;

/** Where a running (or stopped) sandbox lives. */
export type ContainerRef = string;

export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
}

export interface SandboxFileSpec {
  containerPath: string;
  content: string;
  /** Octal mode; the backend's default when absent. */
  mode?: number;
}

export interface SandboxSpec {
  sandboxId: string;
  /**
   * The workspace the sandbox's agent lives in — a DOMAIN id, not a runtime
   * concept. Namespaced backends (the cloud manager) fence every sandbox
   * inside its workspace; the Docker backend ignores it. Optional because an
   * older control plane may not send it — a backend that requires it refuses
   * loudly instead of guessing.
   */
  workspaceId?: string;
  image: string;
  env: Record<string, string>;
  /** Written INTO the sandbox before it starts (CA, credential stubs). */
  files: SandboxFileSpec[];
  homeRef: HomeRef;
  limits: SandboxLimits;
  /**
   * Identifies this exact spawn. The runner stores it with the sandbox so a
   * re-dispatched start can tell "same payload, just start it" from
   * "credentials changed, recreate it".
   */
  payloadHash: string;
}

/** What the backend currently holds for a sandbox — the reconcile input. */
export interface SandboxSnapshot {
  sandboxId: string;
  containerRef: ContainerRef;
  running: boolean;
  payloadHash: string | null;
  /**
   * The substrate's own lifecycle phase, when it has one (a Kubernetes pod
   * phase). Absent/null on substrates without the concept — consumers must
   * treat that as "running is the whole truth". The boot-crash classifier
   * reads it to tell a genuinely TERMINAL container from one that is merely
   * not running yet (Pending while its image pulls).
   */
  phase?: string | null;
}

/**
 * One managed object on the backend's substrate, REGARDLESS of which runner
 * labeled it — the stale-label orphan sweep's input (step 13). The owned
 * lists above are deliberately scoped to this runner's own label; this one
 * enumerates everything the platform ever created here, so orphans from a
 * dead runner id (a control-plane reset, a rotated token) become visible.
 */
export interface ManagedObject {
  kind: "sandbox" | "home";
  ref: string;
  /** Null when the label is missing — never reap what can't be identified. */
  sandboxId: string | null;
  runnerId: string | null;
  /**
   * The installation that created this object (a hash of its runner token) —
   * null when the label is absent (a pre-fix object). The sweep reaps only
   * objects bearing THIS installation's fingerprint, so a different install
   * sharing the daemon is never touched.
   */
  installationId: string | null;
  /** Null when the substrate gave no timestamp — never reap what can't be aged. */
  createdAt: Date | null;
}

export interface SandboxBackend {
  /** Backend id, reported at registration (never a routing key). */
  readonly id: string;

  /**
   * Durability class of this backend's homes (§3.9), declared rather
   * than hidden so the platform can be honest about its loss window.
   */
  readonly homeDurability: "resident" | "snapshot";

  /** Prepare anything the backend needs before it can host sandboxes. */
  prepare(): Promise<void>;

  /**
   * Adopt the control-plane runner id, which is what every object this
   * backend creates is labeled with — and therefore what reconcile matches on.
   *
   * It must be a STABLE identity, not a per-process one: a runner restart that
   * changed its label would stop recognizing the volumes it created before,
   * and they would leak forever with nothing able to see them. Registration
   * returns the same id for the same token, so the runner calls this once,
   * after registering and before touching anything.
   */
  identify(runnerId: string): void;

  // ── Homes (the §3.9 seam) ────────────────────────────────────────
  provisionHome(sandboxId: string): Promise<HomeRef>;
  destroyHome(ref: HomeRef): Promise<void>;
  /** No-ops on `resident` backends; archive/restore on `snapshot` ones. */
  parkHome(ref: HomeRef): Promise<void>;
  wakeHome(ref: HomeRef): Promise<void>;
  listHomes(): Promise<Array<{ sandboxId: string; ref: HomeRef }>>;

  // ── Sandboxes ─────────────────────────────────────────────────────────
  createSandbox(spec: SandboxSpec): Promise<ContainerRef>;
  startSandbox(ref: ContainerRef): Promise<void>;
  /**
   * `sandboxId` is an OPTIONAL efficiency hint (the workspaceId precedent):
   * a namespaced backend can resolve the ref with a label-scoped lookup
   * instead of a fleet-wide scan. Never required — the ref alone must stay
   * sufficient — and the Docker backend ignores it.
   */
  stopSandbox(ref: ContainerRef, sandboxId?: string): Promise<void>;
  removeSandbox(ref: ContainerRef, sandboxId?: string): Promise<void>;
  listSandboxes(): Promise<SandboxSnapshot[]>;

  // ── Orphan sweep (step 13) ────────────────────────────────────────────
  /** Every platform-created container and volume on this substrate,
   * ANY runner's label — networks deliberately excluded (shared). */
  listManaged(): Promise<ManagedObject[]>;
}
