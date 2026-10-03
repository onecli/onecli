/**
 * HTTP client for the remote sandbox service's REST API. Deliberately tiny:
 * base URL + shared service secret, bounded
 * per-call timeouts, and the house error envelope decoded into one typed
 * error — the backend above it speaks the SandboxBackend seam, this file
 * speaks HTTP, and nothing else in the runner knows the service exists.
 *
 * Request bodies are NEVER logged: a create body carries `spec.env`, which
 * includes the sandbox's live gateway proxy token.
 */

/** Default per-call timeout — every endpoint answers promptly… */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * …except create, which can legitimately wait on the service's own
 * admission and startup work.
 */
const CREATE_TIMEOUT_MS = 90_000;
/**
 * …and destroy-home, which waits out any in-flight archive before deleting
 * it — so a truncated home is never resurrected by a late upload. Must
 * exceed the service's own drain ceiling, or the runner aborts mid-drain
 * and logs a spurious reap failure.
 */
const DESTROY_HOME_TIMEOUT_MS = 60_000;

/** The service refused or failed a call — its house envelope, typed. */
export class ManagerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`sandbox-manager ${status} ${code}: ${message}`);
    this.name = "ManagerApiError";
  }
}

/** One sandbox snapshot as the service reports it. */
export interface ManagerSandboxSnapshot {
  sandboxId: string;
  containerRef: string;
  running: boolean;
  payloadHash: string | null;
  phase: string | null;
  waitingReason: string | null;
}

export interface ManagerManagedObject {
  kind: "sandbox" | "home";
  ref: string;
  sandboxId: string | null;
  runnerId: string | null;
  installationId: string | null;
  createdAt: string | null;
}

/** Park/wake progress as the service's stateless state machine reports it. */
export type ParkStatus = "pending" | "parking" | "parked";
export type WakeStatus = "waking" | "ready";

/** Where a brand-new home is born when the wake has to create it: the
 * create body's ownership trio, sent on the wake. The service uses it only
 * for a home that does not exist yet; anything that exists is placed by
 * its own truth. */
export interface ManagerWakePlacement {
  workspaceId: string;
  runnerId: string;
  installationId: string;
}

export interface ManagerCreateSandboxRequest {
  sandboxId: string;
  workspaceId: string;
  runnerId: string;
  installationId: string;
  image: string;
  env: Record<string, string>;
  files: Array<{ containerPath: string; content: string; mode?: number }>;
  homeRef: string;
  limits: { memoryMb: number; cpus: number; pids: number };
  payloadHash: string;
}

export interface ManagerClientOptions {
  baseUrl: string;
  token: string;
}

export interface ManagerClient {
  createSandbox(
    request: ManagerCreateSandboxRequest,
  ): Promise<{ containerRef: string }>;
  startSandbox(ref: string): Promise<void>;
  /** `sandboxId` lets the service resolve the sandbox with a scoped lookup
   * instead of a fleet-wide scan — optional, additive. */
  stopSandbox(ref: string, sandboxId?: string): Promise<void>;
  removeSandbox(ref: string, sandboxId?: string): Promise<void>;
  listSandboxes(runnerId: string): Promise<ManagerSandboxSnapshot[]>;
  provisionHome(sandboxId: string): Promise<{ ref: string }>;
  destroyHome(ref: string): Promise<void>;
  listHomes(
    runnerId: string,
  ): Promise<Array<{ sandboxId: string; ref: string }>>;
  parkHome(ref: string): Promise<{ status: ParkStatus }>;
  wakeHome(
    ref: string,
    placement?: ManagerWakePlacement,
  ): Promise<{ status: WakeStatus }>;
  listManaged(): Promise<ManagerManagedObject[]>;
}

export const createManagerClient = (
  options: ManagerClientOptions,
): ManagerClient => {
  const base = options.baseUrl.replace(/\/+$/, "");

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 204) return null;

    if (!response.ok) {
      // The house envelope when present; a bare status otherwise (a proxy or
      // a dying instance can answer before the service does).
      const envelope = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      throw new ManagerApiError(
        response.status,
        envelope?.error?.code ?? "http_error",
        envelope?.error?.message ?? response.statusText,
      );
    }

    // A 2xx with an unparsable body is a FAILURE, never a null the caller
    // dereferences into a TypeError: a dying instance behind a load balancer
    // can truncate a body mid-read, and that must surface as the typed
    // transport error the retry logic understands.
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ManagerApiError(
        response.status,
        "bad_body",
        "manager answered 2xx with an unparsable body",
      );
    }
  };

  /**
   * Park/wake answers are validated FAIL-CLOSED against the exact status
   * vocabulary: anything else (most likely a version-skewed service) must
   * be an error, never read as
   * progress or, worse, as completion.
   */
  const expectStatus = <T extends string>(
    answer: unknown,
    allowed: readonly T[],
    operation: string,
  ): { status: T } => {
    const status = (answer as { status?: unknown } | null)?.status;
    if (
      typeof status === "string" &&
      (allowed as readonly string[]).includes(status)
    ) {
      return { status: status as T };
    }
    throw new ManagerApiError(
      200,
      "unexpected_status",
      `manager answered ${operation} with ${JSON.stringify(status)} — expected one of ${allowed.join("/")}; is the sandbox-manager older than step 3?`,
    );
  };

  /**
   * The same fail-closed posture for every other 2xx body: a skewed service
   * (or an intermediary answering 2xx JSON of another shape) must surface as
   * the honest `unexpected_status` refusal — never as `undefined` flowing
   * into refs and list logic until it dies somewhere confusing (a
   * `/v1/sandboxes/undefined/start` hours later).
   */
  const expectShape = <T>(
    answer: unknown,
    operation: string,
    valid: (candidate: unknown) => candidate is T,
  ): T => {
    if (valid(answer)) return answer;
    throw new ManagerApiError(
      200,
      "unexpected_status",
      `manager answered ${operation} with an unexpected body shape — is the sandbox-manager older than step 3?`,
    );
  };

  return {
    async createSandbox(request) {
      return expectShape(
        await call("POST", "/v1/sandboxes", request, CREATE_TIMEOUT_MS),
        "create",
        (candidate): candidate is { containerRef: string } =>
          typeof (candidate as { containerRef?: unknown } | null)
            ?.containerRef === "string",
      );
    },

    async startSandbox(ref) {
      await call("POST", `/v1/sandboxes/${encodeURIComponent(ref)}/start`);
    },

    async stopSandbox(ref, sandboxId) {
      const hint = sandboxId
        ? `?sandboxId=${encodeURIComponent(sandboxId)}`
        : "";
      await call(
        "POST",
        `/v1/sandboxes/${encodeURIComponent(ref)}/stop${hint}`,
      );
    },

    async removeSandbox(ref, sandboxId) {
      const hint = sandboxId
        ? `?sandboxId=${encodeURIComponent(sandboxId)}`
        : "";
      await call("DELETE", `/v1/sandboxes/${encodeURIComponent(ref)}${hint}`);
    },

    async listSandboxes(runnerId) {
      return expectShape(
        await call(
          "GET",
          `/v1/sandboxes?runnerId=${encodeURIComponent(runnerId)}`,
        ),
        "list-sandboxes",
        (candidate): candidate is { sandboxes: ManagerSandboxSnapshot[] } =>
          Array.isArray(
            (candidate as { sandboxes?: unknown } | null)?.sandboxes,
          ),
      ).sandboxes;
    },

    async provisionHome(sandboxId) {
      return expectShape(
        await call("POST", "/v1/homes", { sandboxId }),
        "provision-home",
        (candidate): candidate is { ref: string } =>
          typeof (candidate as { ref?: unknown } | null)?.ref === "string",
      );
    },

    async destroyHome(ref) {
      await call(
        "DELETE",
        `/v1/homes/${encodeURIComponent(ref)}`,
        undefined,
        DESTROY_HOME_TIMEOUT_MS,
      );
    },

    async listHomes(runnerId) {
      return expectShape(
        await call("GET", `/v1/homes?runnerId=${encodeURIComponent(runnerId)}`),
        "list-homes",
        (
          candidate,
        ): candidate is {
          homes: Array<{ sandboxId: string; ref: string }>;
        } => Array.isArray((candidate as { homes?: unknown } | null)?.homes),
      ).homes;
    },

    async parkHome(ref) {
      return expectStatus(
        await call("POST", `/v1/homes/${encodeURIComponent(ref)}/park`),
        ["pending", "parking", "parked"] as const,
        "park",
      );
    },

    async wakeHome(ref, placement) {
      return expectStatus(
        await call(
          "POST",
          `/v1/homes/${encodeURIComponent(ref)}/wake`,
          placement,
        ),
        ["waking", "ready"] as const,
        "wake",
      );
    },

    async listManaged() {
      return expectShape(
        await call("GET", "/v1/managed"),
        "list-managed",
        (candidate): candidate is { managed: ManagerManagedObject[] } =>
          Array.isArray((candidate as { managed?: unknown } | null)?.managed),
      ).managed;
    },
  };
};
