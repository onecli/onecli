import type { Readable, Writable } from "node:stream";

/**
 * The terminator's substrate seam. A backend is the pair of answers to the
 * two questions only a substrate can answer — "where is this session's
 * sandbox, and may it be reached?" (the Resolver) and "give me a byte pipe
 * into it" (the ExecBackend) — behind types the core (server/session/relay)
 * threads opaquely: the target `T` is the backend's own vocabulary, and the
 * core never learns it. Substrates are ADDED as new `backend/<name>/`
 * directories, never as edits to the core — the same law as the runner's
 * SandboxBackend.
 */

export type ResolverAnswer<T> =
  | { status: "waking" }
  | {
      status: "ready";
      /** Complete dial coordinates — the exec backend's whole input. */
      target: T;
      /** When the target's credentials lapse — drives the session's
       *  reuse-margin cache; resolvers re-mint per open(), never cache. */
      expiresAt: Date;
    };

/**
 * Turns an authenticated session's (certificate, grant) pair into dial
 * coordinates. A resolver must verify BOTH artifacts against its own trust
 * anchor (never trust the terminator's word — the grant exists to make a
 * compromised relay harmless) and answer `waking` while the sandbox is
 * still coming up; the session's wake poll rides that out, bounded.
 */
export interface Resolver<T> {
  open(input: {
    certificate: string;
    grant: string;
  }): Promise<ResolverAnswer<T>>;
  /** Idempotent by contract; throws on transport failure (call sites are
   * best-effort). */
  close(sessionId: string): Promise<void>;
}

/** Deterministic refusal — retrying the identical request cannot succeed. */
export class ResolverRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ResolverRefusedError";
  }
}

/** Transport-class failure — the wake poll rides it out, bounded. */
export class ResolverUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolverUnreachableError";
  }
}

export interface ExecIo {
  stdout: Writable;
  /** Null with a TTY — the transport merges stderr into the TTY stream. */
  stderr: Writable | null;
  stdin: Readable;
}

export interface ExecHandle {
  /** Present only when the backend supports mid-session terminal resizes. */
  resize?: (cols: number, rows: number) => void;
  /**
   * Resolves with the remote exit code; rejects when the transport dies
   * before an exit status arrives (sandbox churn, network) — the relay
   * reports that honestly as `relay_error`.
   */
  exited: Promise<number>;
  /**
   * Tear the exec down and free its transport — called by the relay when the
   * SSH channel ends by anything other than the guest exiting (a client
   * disconnect, an idle/revocation close). Idempotent: the relay may call it
   * more than once, and a backend whose transport already self-closes on
   * stdin-EOF may make it a no-op.
   */
  dispose(): void;
}

export class ExecDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecDisconnectedError";
  }
}

/** What the SSH client asked for on this channel — seam vocabulary: command
 *  construction is SUBSTRATE policy (identity mechanics differ per substrate:
 *  kube exec lands as root and wraps in an identity drop; docker exec already
 *  lands as the container user), so backends receive the request, never a
 *  pre-built argv. */
export type RelayRequest =
  | { kind: "shell" }
  | { kind: "exec"; command: string }
  | { kind: "sftp" };

/** Opens one byte pipe into the target the resolver answered with. */
export interface ExecBackend<T> {
  exec(
    target: T,
    request: RelayRequest,
    io: ExecIo,
    tty: boolean,
  ): Promise<ExecHandle>;
}

/** One substrate, fully assembled: the resolver and the exec backend that
 *  speak the same target vocabulary. */
export interface TerminatorBackend<T> {
  resolver: Resolver<T>;
  exec: ExecBackend<T>;
}
