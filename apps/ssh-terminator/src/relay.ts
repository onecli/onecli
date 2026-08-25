import { PassThrough } from "node:stream";
import type { ServerChannel } from "ssh2";
import type { ExecBackend, ExecHandle } from "./backend/types";

/**
 * The relay: bridge one ssh2 channel to one exec stream. Command
 * construction and stream wiring live here; WHAT may be relayed was already
 * decided upstream (cert + control plane + resolver).
 */

/**
 * The guest's durable-home contract, duplicated privately (the
 * runner/supervisor precedent): byte-equal with the agent image
 * (docker/agent.Dockerfile, agent-entrypoint.sh) and pinned against
 * apps/sandbox-manager/src/constants.ts by the infra contract test
 * (sandbox-manager-contract.test.ts) — change them ONLY in lockstep.
 */
export const HOME_MOUNT = "/workspace";
export const AGENT_POSIX_HOME = "/workspace/.home";

export type RelayRequest =
  | { kind: "shell" }
  | { kind: "exec"; command: string }
  | { kind: "sftp" };

/** POSIX single-quote: close, escaped quote, reopen (boot-script.ts's sq). */
const sq = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Where the in-guest OpenSSH sftp-server lives (agent image, Debian path). */
const SFTP_SERVER_PATH = "/usr/lib/openssh/sftp-server";

/**
 * Build the in-guest command. `pods/exec` lands as in-container root with
 * root's identity env (HOME=/root, CWD=/app — the boot script's exports are
 * invisible to exec'd processes), which would break VS Code Remote and
 * default scp/sftp paths, so every session wraps in the same identity drop
 * the boot phase uses: explicit identity env, then setpriv to uid-1000
 * "node", landing in /workspace (the durable home; ~ is /workspace/.home on
 * the same volume, so dotfiles — and ~/.vscode-server — survive park/wake).
 *
 * Two pinned constraints, both load-bearing:
 * - NEVER `--reset-env`: it would strip the spawn env, the gateway proxy
 *   credential included, killing all in-guest egress.
 * - The drop is UX/consistency, NOT a security boundary — the customer owns
 *   their guest kernel (privileged container in their own microVM) and can
 *   re-escalate; the real boundaries stay Kata isolation and the gateway
 *   network fence.
 */
export const buildGuestCommand = (request: RelayRequest): string[] => {
  const target =
    request.kind === "shell"
      ? "bash -l"
      : request.kind === "sftp"
        ? SFTP_SERVER_PATH
        : // OpenSSH semantics: the command string runs through a shell (this
          // also covers legacy `scp -O`, which arrives as `exec scp -t …`).
          `sh -lc ${sq(request.command)}`;
  return [
    "env",
    `HOME=${AGENT_POSIX_HOME}`,
    "USER=node",
    "LOGNAME=node",
    "setpriv",
    "--reuid",
    "node",
    "--regid",
    "node",
    "--init-groups",
    "--",
    "sh",
    "-c",
    // mkdir: a RUNNING pre-change sandbox predates the entrypoint that
    // creates the durable home — one idempotent token heals it for this
    // session, post-drop as node (root never mkdirs the tenant mount).
    // Harmless when it exists; 2>/dev/null + || true keep sftp's
    // byte-exact pipe clean and the session alive on any failure.
    `mkdir -p ${AGENT_POSIX_HOME} 2>/dev/null || true; cd ${HOME_MOUNT} 2>/dev/null || cd /home/node; exec ${target}`,
  ];
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
    buildGuestCommand(request),
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
  }
};
