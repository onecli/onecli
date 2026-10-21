import {
  MAX_RUNNER_EVENTS_PER_POST,
  RUNNER_REPLICA_HEADER,
  runnerChannelClaimResponseSchema,
  runnerRegisterResponseSchema,
  runnerSandboxCheckResponseSchema,
  runnerSandboxPortsResponseSchema,
  runnerSandboxesResponseSchema,
  runnerReplicaSelfResponseSchema,
  runnerWorkResponseSchema,
  type RunnerCapabilities,
  type RunnerChannelClaimRequest,
  type RunnerChannelClaimResponse,
  type RunnerEvent,
  type RunnerSandboxesResponse,
  type RunnerSpawnRequest,
  type RunnerWorkItem,
  runnerMemoryWriteResponseSchema,
  RUNNER_ATTACHMENT_HEADERS,
  runnerAttachmentUploadResponseSchema,
  type RunnerAttachmentUploadResponse,
  runnerToolCallResponseSchema,
  type RunnerMemoryWriteRequest,
  type RunnerMemoryWriteResponse,
  type RunnerToolCallRequest,
  type RunnerToolCallResponse,
} from "@onecli/agent-protocol";

/**
 * The runner's only outbound dependency: the control plane's `/v1/runner/*`
 * surface (§3.3 — the runner dials out, nothing dials in). Native fetch, the
 * house pattern for server-side HTTP in this repo.
 */

export interface RunnerRegistration {
  name: string;
  capabilities: RunnerCapabilities;
  /** This process's own name: the copy's identity in the control plane. */
  replicaName: string;
  /** Where this copy serves its port API, if it serves one. */
  portApiUrl?: string;
}

export interface ControlPlaneClient {
  /**
   * Register this process as one copy of the runner. The answered copy id
   * is named on every later call. A control plane that answers no copy id
   * predates running as several copies: refused loudly, because nothing
   * after this would be fenced to the copy that holds a sandbox's socket.
   */
  register(
    registration: RunnerRegistration,
  ): Promise<{ runnerId: string; replicaId: string }>;
  pollWork(wait: number, limit: number): Promise<RunnerWorkItem[]>;
  postEvents(events: RunnerEvent[]): Promise<void>;
  heartbeat(capabilities?: RunnerCapabilities): Promise<void>;
  /** The reconcile truth: the sandbox ids this runner should be hosting
   * (the reap authority) plus — from a control plane new enough to send it —
   * what it currently believes about each (the vanished-pod arm's input). */
  listAssignedSandboxes(): Promise<RunnerSandboxesResponse>;
  /**
   * This copy's reconciler role on its own (`GET /v1/runner/replicas/self`),
   * so a copy that will not reconcile never fetches the full listing.
   * `undefined` when the api is too old to answer it (404): the listing's
   * own `reconciler` then decides, as before. Throws on anything else.
   */
  isReconciler(): Promise<boolean | undefined>;
  /** The orphan sweep's authority: which of these sandbox ids exist NOWHERE
   * in the control plane. Throws on any failure — the sweep destroys nothing
   * without a positive answer. */
  checkSandboxIds(sandboxIds: string[]): Promise<string[]>;
  /** The live shared ports of a sandbox this runner hosts: the ONLY source
   * the port allowlist is armed from. Throws on any failure (the caller
   * then arms nothing: fail closed). */
  sandboxAllowedPorts(sandboxId: string): Promise<number[]>;
  /**
   * Record the spawn a start just created (its container and the SHA-256 of
   * the bootstrap token baked into it), so any copy can accept its first
   * connect. `false` when the start no longer applies (the sandbox moved
   * on, or another copy owns it now): the start stands down. Throws on
   * anything else.
   */
  recordSpawn(sandboxId: string, spawn: RunnerSpawnRequest): Promise<boolean>;
  /** Take a supervisor's control channel as its socket opens. `null` when
   * refused (hint-free); throws on transport failure. */
  claimChannel(
    claim: RunnerChannelClaimRequest,
  ): Promise<RunnerChannelClaimResponse | null>;
  /** A socket this copy held closed. A no-op server-side when that
   * connection no longer holds the channel. */
  releaseChannel(connectionId: string): Promise<void>;
  /** Claim the stop of a container still running although its sandbox is
   * parked. `false` when a start got there first. */
  claimStrayStop(sandboxId: string, containerRef: string): Promise<boolean>;
  /** A clean shutdown: hand this copy's sandboxes and channels over at once
   * rather than after the liveness window. */
  retire(): Promise<void>;
  /** Relay a platform-tool call (step 7) and return the control plane's
   * answer. Throws on transport failure — the caller turns that into a tool
   * error, never silence. */
  toolCall(request: RunnerToolCallRequest): Promise<RunnerToolCallResponse>;
  /** Relay a harvested memory-file write (the projection's write-back half)
   * — same contract as toolCall: throws on transport failure, the caller
   * answers the sandbox in both outcomes. */
  memoryWrite(
    request: RunnerMemoryWriteRequest,
  ): Promise<RunnerMemoryWriteResponse>;
  /** Pull one attachment's bytes behind a `turn.deliver` manifest (bytes
   * deliberately never ride the poll JSON). Throws on any non-200 — the
   * caller degrades to delivering the turn without the file. */
  fetchAttachment(attachmentId: string): Promise<Buffer>;
  /**
   * Push one file the agent is sending back (send_file): raw bytes, metadata
   * in the named headers. The toolCall contract: throws on transport
   * failure; the api's refusals arrive as a parsed `ok:false`. A 413 (body
   * over the api's cap) and a 400 (malformed headers) are answered as
   * NON-retryable refusals here rather than thrown, since retrying the same
   * bytes cannot succeed.
   */
  uploadAttachment(
    sandboxId: string,
    file: {
      conversationId: string;
      turnId: string;
      name: string;
      mimeType: string;
      sha256: string;
      caption?: string;
      bytes: Buffer;
    },
  ): Promise<RunnerAttachmentUploadResponse>;
}

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Event-post retry law. Retried statuses are ONLY the ones where the server
 * provably did not apply the batch — `turn.events` re-posts otherwise
 * duplicate transcript rows, because `seq` is assigned server-side at
 * arrival (routes/runner.ts says it out loud):
 *
 * - 429: a middlebox (a fronting proxy, a rate limiter) refused the request
 *   before the origin — the api-server never answers it on this surface —
 *   and a throttle can clear within the backoff budget.
 * - 500: the events route answers 500 only when ZERO events applied
 *   (per-event try/catch inside one transaction; partial success is a 204).
 *   Residual: an intermediary-synthesized 500 is indistinguishable from the
 *   route's own, but the route's contract makes the common case safe.
 * - 503: no healthy target behind the load balancer — never processed, and a
 *   deploy window clears in seconds.
 *
 * - A request that never left: the connection was refused, or the host did
 *   not resolve (an api mid-restart: a self-host compose service is briefly
 *   absent from DNS, a listener briefly closed). Not one byte reached the
 *   control plane, so this is as provably unapplied as a 503.
 *
 * NEVER retried: timeouts, resets and every other network error, and
 * 502/504. The request may have landed and the response been lost, exactly
 * the duplicate-transcript case.
 * 403 is deliberately NOT retried either, though it is provably unapplied:
 * a WAF content rule matching the batch body is deterministic (identical
 * bytes re-refused every time), and a WAF per-IP rate block outlasts this
 * backoff budget while every retry feeds the counter that sustains it — so
 * a 403 fails fast (one warn, batch dropped) instead of holding the head of
 * the report chain for guaranteed-futile attempts.
 * Retries happen per chunk, in place, so the report chains' arrival order
 * (which decides `seq`) is preserved; the bounded budget keeps a sustained
 * outage from wedging the head of the chain past what the drop queue absorbs.
 */
const RETRYABLE_EVENT_STATUSES = new Set([429, 500, 503]);
const EVENT_POST_ATTEMPTS = 4;
const EVENT_RETRY_BACKOFF_MS = [1_000, 4_000, 10_000];

/** Socket codes for a request that never left this process. */
const NEVER_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

const neverLeft = (attempt: unknown): boolean =>
  attempt instanceof Error &&
  "code" in attempt &&
  typeof attempt.code === "string" &&
  NEVER_SENT_CODES.has(attempt.code);

/**
 * Whether a fetch failed before a single byte reached the control plane.
 * fetch wraps the socket error as `cause`. With dual-stack address selection
 * that cause is an AggregateError over each attempt, and its own `code` is
 * just the FIRST attempt's, so every attempt is checked instead: one timeout
 * or reset among them means the request may have landed.
 */
const requestNeverSent = (error: unknown): boolean => {
  if (!(error instanceof Error) || !(error.cause instanceof Error)) {
    return false;
  }
  const attempts: unknown[] =
    error.cause instanceof AggregateError ? error.cause.errors : [error.cause];
  return attempts.length > 0 && attempts.every(neverLeft);
};

/**
 * The retry law above as one predicate: the post provably never applied, so
 * sending it again cannot duplicate anything. Shared with the report chain,
 * which re-sends a turn's end on exactly this verdict.
 */
export const isProvablyUnapplied = (error: unknown): boolean =>
  error instanceof ControlPlaneError
    ? RETRYABLE_EVENT_STATUSES.has(error.status)
    : requestNeverSent(error);

export interface ControlPlaneOptions {
  baseUrl: string;
  token: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests (the retry backoff); defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export const createControlPlaneClient = ({
  baseUrl,
  token,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
}: ControlPlaneOptions): ControlPlaneClient => {
  const origin = baseUrl.replace(/\/$/, "");
  /** Set by `register`; named on every call after it. */
  let replicaId: string | undefined;

  /** The headers every runner call carries: the runner credential, and the
   * copy once registered. One place, so no call can forget the copy. */
  const identity = (): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    ...(replicaId !== undefined && { [RUNNER_REPLICA_HEADER]: replicaId }),
  });

  const send = async (
    path: string,
    init: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      timeoutMs: number;
    },
  ): Promise<Response> =>
    fetchImpl(`${origin}${path}`, {
      method: init.method,
      headers: {
        ...identity(),
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs),
    });

  const failed = (method: string, path: string, status: number) =>
    new ControlPlaneError(status, `${method} ${path} failed: ${status}`);

  const call = async (
    path: string,
    init: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      timeoutMs: number;
    },
  ): Promise<unknown> => {
    const response = await send(path, init);
    if (!response.ok) throw failed(init.method, path, response.status);
    if (response.status === 204) return null;
    return response.json();
  };

  /**
   * A claim whose refusal is an ANSWER, not a failure: 409 (the state moved
   * on) reads as `false`, success as `true`, anything else throws.
   */
  const applied = async (
    path: string,
    init: { method: "POST" | "PUT"; body: unknown; timeoutMs: number },
  ): Promise<boolean> => {
    const response = await send(path, init);
    if (response.status === 409) return false;
    if (!response.ok) throw failed(init.method, path, response.status);
    return true;
  };

  const sandboxPath = (sandboxId: string, rest: string) =>
    `/v1/runner/sandboxes/${encodeURIComponent(sandboxId)}/${rest}`;

  return {
    async register(registration) {
      const body = runnerRegisterResponseSchema.parse(
        await call("/v1/runner/register", {
          method: "POST",
          body: registration,
          timeoutMs: 15_000,
        }),
      );
      if (body.replicaId === undefined) {
        throw new Error(
          "the control plane is too old for this runner (it answered no " +
            "runner copy id): deploy the api before the runner",
        );
      }
      replicaId = body.replicaId;
      return { runnerId: body.runnerId, replicaId: body.replicaId };
    },

    async pollWork(wait, limit) {
      // The held poll is bounded server-side (25s); this timeout only needs
      // to outlast it plus travel.
      const body = await call("/v1/runner/work", {
        method: "POST",
        body: { wait, limit },
        timeoutMs: (wait + 15) * 1000,
      });
      return runnerWorkResponseSchema.parse(body).items;
    },

    async postEvents(events) {
      // Chunked at the wire schema's ceiling, sequentially so arrival order
      // is preserved (the report chain depends on it): a reconcile pass over
      // a big fleet must degrade to more requests, never to one 400 that
      // loses the whole report.
      for (let i = 0; i < events.length; i += MAX_RUNNER_EVENTS_PER_POST) {
        const body = {
          events: events.slice(i, i + MAX_RUNNER_EVENTS_PER_POST),
        };
        // Bounded in-place retry for statuses the retry law (top of file)
        // proves safe: the chunk provably never applied, so a re-post cannot
        // duplicate transcript rows, and retrying HERE keeps chunk order.
        for (let attempt = 1; ; attempt += 1) {
          try {
            await call("/v1/runner/events", {
              method: "POST",
              body,
              timeoutMs: 15_000,
            });
            break;
          } catch (error) {
            if (attempt >= EVENT_POST_ATTEMPTS || !isProvablyUnapplied(error)) {
              throw error;
            }
            await sleepImpl(EVENT_RETRY_BACKOFF_MS[attempt - 1] ?? 10_000);
          }
        }
      }
    },

    async toolCall(request) {
      // 15s transport ceiling sits inside the supervisor's 25s correlator,
      // which sits inside jcode's 30s — every layer times out into the layer
      // above's error text, never into a vendor's generic one.
      const body = await call("/v1/runner/tool-call", {
        method: "POST",
        body: request,
        timeoutMs: 15_000,
      });
      return runnerToolCallResponseSchema.parse(body);
    },

    async memoryWrite(request) {
      // The toolCall ceilings: 15s transport inside the supervisor's 25s
      // correlator. A 400 (schema refusal) throws ControlPlaneError — the
      // relay maps it to a non-retryable refusal for this content.
      const body = await call("/v1/runner/memory-write", {
        method: "POST",
        body: request,
        timeoutMs: 15_000,
      });
      return runnerMemoryWriteResponseSchema.parse(body);
    },

    async heartbeat(capabilities) {
      await call("/v1/runner/heartbeat", {
        method: "POST",
        body: capabilities ? { capabilities } : {},
        timeoutMs: 15_000,
      });
    },

    async uploadAttachment(sandboxId, file) {
      // No explicit content-length: fetch derives it from the byte body, and
      // a caller-set one collided with it inside undici (`fetch failed` /
      // `invalid content-length header`, seen on the real e2e path). The
      // route's own cap reads the header fetch writes.
      const headers: Record<string, string> = {
        ...identity(),
        "content-type": file.mimeType,
        [RUNNER_ATTACHMENT_HEADERS.sandboxId]: sandboxId,
        [RUNNER_ATTACHMENT_HEADERS.conversationId]: file.conversationId,
        [RUNNER_ATTACHMENT_HEADERS.turnId]: file.turnId,
        // Header values are Latin-1: percent-encode the human strings.
        [RUNNER_ATTACHMENT_HEADERS.name]: encodeURIComponent(file.name),
        [RUNNER_ATTACHMENT_HEADERS.sha256]: file.sha256,
        ...(file.caption !== undefined && {
          [RUNNER_ATTACHMENT_HEADERS.caption]: encodeURIComponent(file.caption),
        }),
      };
      // Binary, so not through `call`. 60s: 25 MB over a slow link, bounded
      // under the supervisor tool's own ceiling only if the link is healthy —
      // a slower one surfaces as the tool's timeout, which is honest.
      const response = await fetchImpl(`${origin}/v1/runner/attachments`, {
        method: "POST",
        headers,
        body: new Uint8Array(file.bytes),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 413 || response.status === 400) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        return {
          ok: false,
          error: body?.error ?? "The platform refused this file.",
        };
      }
      if (!response.ok) {
        throw failed("POST", "/v1/runner/attachments", response.status);
      }
      return runnerAttachmentUploadResponseSchema.parse(await response.json());
    },

    async fetchAttachment(attachmentId) {
      // Binary, so not through `call` (which JSON-parses). 30s: a 10MB file
      // over a slow link, still bounded well under the turn ceiling.
      const response = await fetchImpl(
        `${origin}/v1/runner/attachments/${encodeURIComponent(attachmentId)}`,
        {
          method: "GET",
          headers: identity(),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        throw failed("GET", "/v1/runner/attachments", response.status);
      }
      return Buffer.from(await response.arrayBuffer());
    },

    async listAssignedSandboxes() {
      // Parsed, not cast: this list decides what reconcile destroys, so a
      // response that isn't the shape we expect must throw (reconcile logs and
      // skips) rather than read as an empty list and reap every sandbox.
      // `statuses` is additive-optional — absent from an old control plane,
      // which leaves the vanished-pod arm inert.
      const body = await call("/v1/runner/sandboxes", {
        method: "GET",
        timeoutMs: 15_000,
      });
      return runnerSandboxesResponseSchema.parse(body);
    },

    async isReconciler() {
      const path = "/v1/runner/replicas/self";
      const response = await send(path, { method: "GET", timeoutMs: 15_000 });
      if (response.status === 404) return undefined;
      if (!response.ok) throw failed("GET", path, response.status);
      return runnerReplicaSelfResponseSchema.parse(await response.json())
        .reconciler;
    },

    async checkSandboxIds(sandboxIds: string[]) {
      // Same zod-parse-don't-cast law as listAssignedSandboxes, and for the same
      // reason: this answer decides what the orphan sweep force-deletes.
      const body = await call("/v1/runner/sandboxes/check", {
        method: "POST",
        body: { sandboxIds },
        timeoutMs: 15_000,
      });
      return runnerSandboxCheckResponseSchema.parse(body).missing;
    },

    async sandboxAllowedPorts(sandboxId: string) {
      const body = await call(sandboxPath(sandboxId, "ports"), {
        method: "GET",
        timeoutMs: 10_000,
      });
      return runnerSandboxPortsResponseSchema.parse(body).ports;
    },

    async recordSpawn(sandboxId, spawn) {
      return applied(sandboxPath(sandboxId, "spawn"), {
        method: "PUT",
        body: spawn,
        timeoutMs: 15_000,
      });
    },

    async claimChannel(claim) {
      // Parsed, not cast: the answer names the sandbox this socket will speak
      // for, so a wrong-shaped 200 must throw rather than attribute frames.
      const response = await send("/v1/runner/channels", {
        method: "POST",
        body: claim,
        timeoutMs: 10_000,
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw failed("POST", "/v1/runner/channels", response.status);
      }
      return runnerChannelClaimResponseSchema.parse(await response.json());
    },

    async releaseChannel(connectionId) {
      await call(`/v1/runner/channels/${encodeURIComponent(connectionId)}`, {
        method: "DELETE",
        timeoutMs: 10_000,
      });
    },

    async claimStrayStop(sandboxId, containerRef) {
      return applied(sandboxPath(sandboxId, "stray-stop"), {
        method: "POST",
        body: { containerRef },
        timeoutMs: 15_000,
      });
    },

    async retire() {
      await call("/v1/runner/replicas/self", {
        method: "DELETE",
        timeoutMs: 5_000,
      });
    },
  };
};
