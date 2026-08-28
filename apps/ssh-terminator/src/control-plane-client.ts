import { logger } from "./logger";

const log = logger.child({ component: "control-plane-client" });

/**
 * The terminator's client for the control plane's dedicated surface
 * (/v1/ssh-terminator, authenticated with `x-terminator-secret`). The
 * control plane is the ONLY authority on access: session-open re-verifies
 * the certificate and runs the full access law server-side, so this client's
 * job is transport plus fail-closed response parsing — a malformed answer is
 * an error, never a guess. Request and response bodies are never logged (the
 * open body carries the user's certificate).
 */

export interface SessionPolicy {
  maxSessionSeconds: number;
  idleTimeoutSeconds: number;
  heartbeatSeconds: number;
}

export interface OpenedSession {
  sessionId: string;
  /** CA-signed grant, opaque here — only the broker interprets it. */
  grant: string;
  policy: SessionPolicy;
}

export interface HeartbeatAnswer {
  revoked: boolean;
  reason?: string;
}

/** The control plane deterministically refused to open the session. */
export class SessionOpenRefusedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SessionOpenRefusedError";
  }
}

export class ControlPlaneUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneUnreachableError";
  }
}

export interface ControlPlaneClient {
  openSession(input: {
    certificate: string;
    sourceIp: string;
  }): Promise<OpenedSession>;
  /**
   * Returns the revocation verdict. A revocation is ALWAYS a 200 with
   * `{revoked: true}` — the service closes a revoked session server-side at
   * detection and answers the verdict; it never expresses one as an HTTP
   * status. So a non-OK answer (a WAF block, a deploy window, secret-rotation
   * skew) and a malformed body both throw ControlPlaneUnreachableError, and
   * the caller's consecutive-strike accounting decides when to fail closed —
   * the lease expiring server-side bounds how long a deaf relay can run.
   */
  heartbeat(sessionId: string, attached: boolean): Promise<HeartbeatAnswer>;
  /** Throws on failure; call sites treat close reporting as best-effort. */
  close(sessionId: string, reason: string): Promise<void>;
}

const OPEN_TIMEOUT_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 5_000;

const positiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

/** The API's one error shape: `{error: {message, type}}`. */
const refusalMessageOf = (body: unknown): string => {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error: unknown = body.error;
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return error.message;
    }
  }
  return "session refused";
};

const parseOpened = (body: unknown): OpenedSession => {
  if (typeof body !== "object" || body === null) {
    throw new ControlPlaneUnreachableError(
      "session-open answered a non-object",
    );
  }
  const record: Record<string, unknown> = { ...body };
  const policy: Record<string, unknown> =
    typeof record.policy === "object" && record.policy !== null
      ? { ...record.policy }
      : {};
  if (
    !nonEmptyString(record.sessionId) ||
    !nonEmptyString(record.grant) ||
    !positiveInt(policy.maxSessionSeconds) ||
    !positiveInt(policy.idleTimeoutSeconds) ||
    !positiveInt(policy.heartbeatSeconds)
  ) {
    throw new ControlPlaneUnreachableError(
      "session-open answered a malformed body",
    );
  }
  return {
    sessionId: record.sessionId,
    grant: record.grant,
    policy: {
      maxSessionSeconds: policy.maxSessionSeconds,
      idleTimeoutSeconds: policy.idleTimeoutSeconds,
      heartbeatSeconds: policy.heartbeatSeconds,
    },
  };
};

export interface ControlPlaneClientOptions {
  baseUrl: string;
  /** The terminator secret, loaded at boot (null until then — calls refuse). */
  getSecret: () => string | null;
}

export const createControlPlaneClient = (
  options: ControlPlaneClientOptions,
): ControlPlaneClient => {
  const base = options.baseUrl.replace(/\/$/, "");

  const call = async (
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> => {
    const secret = options.getSecret();
    if (!secret) {
      throw new ControlPlaneUnreachableError(
        "terminator secret not loaded yet",
      );
    }
    try {
      return await fetch(`${base}/v1/ssh-terminator${path}`, {
        method: "POST",
        headers: {
          "x-terminator-secret": secret,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ControlPlaneUnreachableError(
        `control plane unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    async openSession(input) {
      const answer = await call("/sessions", input, OPEN_TIMEOUT_MS);
      if (answer.ok) return parseOpened(await answer.json().catch(() => null));
      if (answer.status >= 400 && answer.status < 500) {
        const body: unknown = await answer.json().catch(() => null);
        throw new SessionOpenRefusedError(
          answer.status,
          refusalMessageOf(body),
        );
      }
      throw new ControlPlaneUnreachableError(
        `session-open answered ${answer.status}`,
      );
    },

    async heartbeat(sessionId, attached) {
      const answer = await call(
        `/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
        { attached },
        HEARTBEAT_TIMEOUT_MS,
      );
      if (!answer.ok) {
        // NOT a revocation: the service answers a real revocation as a 200
        // with {revoked:true} and closes the row server-side at detection —
        // it never expresses one as an HTTP status. A non-ok here is
        // infrastructure between us and the service (a WAF block on the
        // public path, an api-server deploy window, secret-rotation skew —
        // the broker client's own 401-is-transport stance). Treating it as
        // revoked killed live sessions with a "your access was revoked" lie
        // on the first blocked beat; throwing routes it into the caller's
        // consecutive-strike accounting instead, and the server-side lease
        // bounds how long a deaf relay can keep running.
        log.warn({ status: answer.status }, "heartbeat answered non-ok");
        throw new ControlPlaneUnreachableError(
          `heartbeat answered ${answer.status}`,
        );
      }
      // Malformed 200s are errors too, never a guess (the file's own law) —
      // a verdict-less body means we did not hear the control plane, not
      // that it revoked the session.
      const body: unknown = await answer.json().catch(() => null);
      if (typeof body !== "object" || body === null) {
        throw new ControlPlaneUnreachableError(
          "heartbeat answered a non-object",
        );
      }
      const record: Record<string, unknown> = { ...body };
      if (typeof record.revoked !== "boolean") {
        throw new ControlPlaneUnreachableError(
          "heartbeat answered a malformed body",
        );
      }
      return {
        revoked: record.revoked,
        ...(nonEmptyString(record.reason) && { reason: record.reason }),
      };
    },

    async close(sessionId, reason) {
      const answer = await call(
        `/sessions/${encodeURIComponent(sessionId)}/close`,
        { reason },
        CLOSE_TIMEOUT_MS,
      );
      if (!answer.ok) {
        throw new ControlPlaneUnreachableError(
          `session-close answered ${answer.status}`,
        );
      }
    },
  };
};
