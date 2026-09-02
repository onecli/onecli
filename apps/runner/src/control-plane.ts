import {
  MAX_RUNNER_EVENTS_PER_POST,
  runnerRegisterResponseSchema,
  runnerSandboxCheckResponseSchema,
  runnerSandboxesResponseSchema,
  runnerWorkResponseSchema,
  type RunnerCapabilities,
  type RunnerEvent,
  type RunnerSandboxesResponse,
  type RunnerWorkItem,
  runnerMemoryWriteResponseSchema,
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

export interface ControlPlaneClient {
  register(
    name: string,
    capabilities: RunnerCapabilities,
  ): Promise<{ runnerId: string }>;
  pollWork(wait: number, limit: number): Promise<RunnerWorkItem[]>;
  postEvents(events: RunnerEvent[]): Promise<void>;
  heartbeat(capabilities?: RunnerCapabilities): Promise<void>;
  /** The reconcile truth: the sandbox ids this runner should be hosting
   * (the reap authority) plus — from a control plane new enough to send it —
   * what it currently believes about each (the vanished-pod arm's input). */
  listAssignedSandboxes(): Promise<RunnerSandboxesResponse>;
  /** The orphan sweep's authority: which of these sandbox ids exist NOWHERE
   * in the control plane. Throws on any failure — the sweep destroys nothing
   * without a positive answer. */
  checkSandboxIds(sandboxIds: string[]): Promise<string[]>;
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
 * NEVER retried: timeouts, network errors, 502/504 — the request may have
 * landed and the response been lost, exactly the duplicate-transcript case.
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
  const call = async (
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
  ): Promise<unknown> => {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs),
    });

    if (!response.ok) {
      throw new ControlPlaneError(
        response.status,
        `${init.method} ${path} failed: ${response.status}`,
      );
    }

    if (response.status === 204) return null;
    return response.json();
  };

  return {
    async register(name, capabilities) {
      const body = await call("/v1/runner/register", {
        method: "POST",
        body: { name, capabilities },
        timeoutMs: 15_000,
      });
      return runnerRegisterResponseSchema.parse(body);
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
            if (
              attempt >= EVENT_POST_ATTEMPTS ||
              !(error instanceof ControlPlaneError) ||
              !RETRYABLE_EVENT_STATUSES.has(error.status)
            ) {
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

    async fetchAttachment(attachmentId) {
      // Binary, so not through `call` (which JSON-parses). 30s: a 10MB file
      // over a slow link, still bounded well under the turn ceiling.
      const response = await fetchImpl(
        `${baseUrl.replace(/\/$/, "")}/v1/runner/attachments/${encodeURIComponent(attachmentId)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        throw new ControlPlaneError(
          response.status,
          `GET /v1/runner/attachments failed: ${response.status}`,
        );
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
  };
};
