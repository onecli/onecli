import {
  ResolverRefusedError,
  ResolverUnreachableError,
  type Resolver,
  type ResolverAnswer,
} from "../types";
import type { KubeExecTarget } from "./exec-backend";

/**
 * The kube substrate's resolver: a client for the sandbox-manager's session
 * broker (/v1/ssh-sessions on the manager, behind the broker's OWN bearer
 * secret — never the runner↔manager one). The broker independently verifies
 * the certificate AND the control-plane grant against its own trust anchor,
 * so this client just carries both through and parses the answer fail-closed,
 * then completes the target with the boot-constant API-server coordinates
 * (server + caFile) — the core never learns kube vocabulary. Bodies are
 * never logged (they carry the certificate and the grant).
 */

const OPEN_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;

/** The manager's refusal codes — anything else is transport-class. */
const REFUSAL_CODES = new Set([
  "ssh_not_configured",
  "cert_refused",
  "grant_refused",
  "identity_mismatch",
]);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

/** The manager envelope's code/message, when the body carries one. */
const refusalOf = (body: unknown): { code: string; message: string } | null => {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return null;
  }
  const error: unknown = body.error;
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code: unknown = error.code;
  if (typeof code !== "string" || code === "") return null;
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : "broker refused the session";
  return { code, message };
};

export interface KubeResolverOptions {
  /** Manager base URL for the session broker (/v1/ssh-sessions). */
  managerUrl: string;
  /** The broker secret, loaded at boot (null until then — calls refuse). */
  getSecret: () => string | null;
  /** Boot-constant API-server coordinates merged into every ready target. */
  kube: Pick<KubeExecTarget, "server" | "caFile">;
}

export const createKubeResolver = (
  options: KubeResolverOptions,
): Resolver<KubeExecTarget> => {
  const base = options.managerUrl.replace(/\/$/, "");

  const parseAnswer = (body: unknown): ResolverAnswer<KubeExecTarget> => {
    if (typeof body !== "object" || body === null) {
      throw new ResolverUnreachableError("broker answered a non-object body");
    }
    const record: Record<string, unknown> = { ...body };
    if (record.status === "waking") return { status: "waking" };
    if (record.status === "ready") {
      const expiresAt = nonEmptyString(record.tokenExpiresAt)
        ? new Date(record.tokenExpiresAt)
        : new Date(Number.NaN);
      if (
        !nonEmptyString(record.namespace) ||
        !nonEmptyString(record.pod) ||
        !nonEmptyString(record.container) ||
        !nonEmptyString(record.token) ||
        Number.isNaN(expiresAt.getTime())
      ) {
        throw new ResolverUnreachableError("broker answered a malformed ready");
      }
      return {
        status: "ready",
        target: {
          namespace: record.namespace,
          pod: record.pod,
          container: record.container,
          token: record.token,
          server: options.kube.server,
          caFile: options.kube.caFile,
        },
        expiresAt,
      };
    }
    throw new ResolverUnreachableError("broker answered an unknown status");
  };

  const call = async (
    path: string,
    init: { method: string; body?: string; timeoutMs: number },
  ): Promise<Response> => {
    const secret = options.getSecret();
    if (!secret) {
      throw new ResolverUnreachableError("broker secret not loaded yet");
    }
    try {
      return await fetch(`${base}/v1/ssh-sessions${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(init.body !== undefined && {
            "content-type": "application/json",
          }),
        },
        ...(init.body !== undefined && { body: init.body }),
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch (error) {
      throw new ResolverUnreachableError(
        `broker unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    async open(input) {
      const answer = await call("", {
        method: "POST",
        body: JSON.stringify(input),
        timeoutMs: OPEN_TIMEOUT_MS,
      });
      if (answer.ok) return parseAnswer(await answer.json().catch(() => null));
      const refusal = refusalOf(await answer.json().catch(() => null));
      if (refusal && REFUSAL_CODES.has(refusal.code)) {
        throw new ResolverRefusedError(refusal.code, refusal.message);
      }
      // A 401 here is secret-rotation skew, unknown codes are version skew —
      // both transport-class: the wake poll rides them out, bounded.
      throw new ResolverUnreachableError(
        `broker open answered ${answer.status}`,
      );
    },

    async close(sessionId) {
      const answer = await call(`/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        timeoutMs: CLOSE_TIMEOUT_MS,
      });
      if (!answer.ok && answer.status !== 404) {
        throw new ResolverUnreachableError(
          `broker close answered ${answer.status}`,
        );
      }
    },
  };
};
