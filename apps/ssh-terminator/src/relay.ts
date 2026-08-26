import { PassThrough } from "node:stream";
import type { ServerChannel } from "ssh2";
import type { ExecBackend, ExecHandle, RelayRequest } from "./backend/types";

/**
 * The relay: bridge one ssh2 channel to one exec stream. Stream wiring and
 * the shared in-guest PAYLOAD live here; the identity mechanics around the
 * payload are substrate policy (each ExecBackend builds its own full
 * command from the request). WHAT may be relayed was already decided
 * upstream (cert + control plane + resolver).
 */

export type { RelayRequest } from "./backend/types";

/**
 * The guest's durable-home contract, duplicated privately (the
 * runner/supervisor precedent): byte-equal with the agent image
 * (docker/agent.Dockerfile, agent-entrypoint.sh) and pinned against
 * apps/sandbox-manager/src/constants.ts by the infra contract test
 * (sandbox-manager-contract.test.ts) — change them ONLY in lockstep.
 */
export const HOME_MOUNT = "/workspace";
export const AGENT_POSIX_HOME = "/workspace/.home";

/** POSIX single-quote: close, escaped quote, reopen (boot-script.ts's sq). */
const sq = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Where the in-guest OpenSSH sftp-server lives (agent image, Debian path). */
const SFTP_SERVER_PATH = "/usr/lib/openssh/sftp-server";

/**
 * The substrate-neutral in-guest payload: land in the durable home and exec
 * the requested program. Every substrate runs this exact script (the kube
 * backend wraps it in its root→node identity drop; the docker backend runs
 * it directly as node) — the durable-home semantics must never fork between
 * substrates.
 *
 * mkdir: a RUNNING pre-change sandbox predates the entrypoint that creates
 * the durable home — one idempotent token heals it for this session.
 * Harmless when it exists; 2>/dev/null + || true keep sftp's byte-exact
 * pipe clean and the session alive on any failure.
 */
export const buildGuestPayload = (request: RelayRequest): string => {
  const target =
    request.kind === "shell"
      ? "bash -l"
      : request.kind === "sftp"
        ? SFTP_SERVER_PATH
        : // OpenSSH semantics: the command string runs through a shell (this
          // also covers legacy `scp -O`, which arrives as `exec scp -t …`).
          `sh -lc ${sq(request.command)}`;
  return `mkdir -p ${AGENT_POSIX_HOME} 2>/dev/null || true; cd ${HOME_MOUNT} 2>/dev/null || cd /home/node; exec ${target}`;
};

export interface TerminalSizeSource {
  current(): { cols: number; rows: number } | null;
  /** Subscribe to window-change events; returns an unsubscribe. */
  onChange(
    listener: (size: { cols: number; rows: number }) => void,
  ): () => void;
}

export interface RunRelayOptions<T> {
  backend: ExecBackend<T>;
  target: T;
  request: RelayRequest;
  channel: ServerChannel;
  /** Non-null when the client allocated a PTY on this ssh2 session. */
  size: TerminalSizeSource;
  /** Idle-timeout feed: fired on payload bytes in either direction. */
  onActivity(): void;
  /** Fired once the exec stream is established (the user reached the box). */
  onAttached?(): void;
}

/**
 * Run one channel to completion. Resolves with the guest exit code after the
 * exit status has been sent; rejects (ExecDisconnectedError et al.) when the
 * transport dies first — the caller closes the whole session honestly as
 * `relay_error`.
 */
export const runRelay = async <T>(
  options: RunRelayOptions<T>,
): Promise<number> => {
  const { channel, request } = options;
  const pty = options.size.current();
  // The API server refuses stderr alongside tty (the TTY stream carries
  // both); sftp is a byte-exact protocol pipe, never a TTY.
  const tty = pty !== null && request.kind !== "sftp";

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let stderr: PassThrough | null = null;
  if (!tty) {
    stderr = new PassThrough();
  }

  const handle: ExecHandle = await options.backend.exec(
    options.target,
    request,
    { stdout, stderr, stdin },
    tty,
  );
  options.onAttached?.();

  // The channel is wired only AFTER the exec stream is established. A failed
  // dial (the caller's pre-attach re-resolve retries runRelay on the SAME
  // channel) must not leave bytes stranded in a dead PassThrough or a stale
  // pipe holding backpressure. Bytes the client sends during the dial (sftp's
  // INIT packet, typed-ahead keystrokes) buffer in the paused channel — no
  // 'data' listener or pipe lands on it until here — and flush on pipe().
  channel.pipe(stdin);
  channel.on("data", () => options.onActivity());
  stdout.on("data", () => options.onActivity());
  stdout.pipe(channel, { end: false });
  if (stderr) {
    stderr.pipe(channel.stderr, { end: false });
  }

  // Tear the exec down when the SSH channel ends by ANYTHING other than the
  // guest exiting — a client disconnect, an idle/revocation close severing
  // the channel. Without this the backend's transport (a docker TTY exec
  // suppresses stdin-EOF propagation, so its hijacked socket would never
  // close) and the guest process leak for the container's lifetime.
  // `dispose()` is idempotent; `exited` resolves via the backend's own
  // close path once the transport drops.
  channel.once("close", () => handle.dispose());

  let unsubscribe: () => void = () => undefined;
  if (handle.resize && pty) {
    const resize = handle.resize;
    resize(pty.cols, pty.rows);
    unsubscribe = options.size.onChange((size) => resize(size.cols, size.rows));
  }

  try {
    const code = await handle.exited;
    channel.exit(code);
    channel.end();
    return code;
  } finally {
    unsubscribe();
    handle.dispose();
  }
};
