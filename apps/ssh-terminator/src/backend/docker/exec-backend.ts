import type { Writable } from "node:stream";
import { logger } from "../../logger";
import { AGENT_POSIX_HOME, buildGuestPayload } from "../../relay";
import {
  ExecDisconnectedError,
  type ExecBackend,
  type RelayRequest,
} from "../types";
import { createDockerStreamDemuxer } from "./demux";
import type { DockerEngineApi, ExecCreateConfig } from "./engine-api";

const log = logger.child({ component: "docker-exec-backend" });

/** The docker substrate's target vocabulary — resolved at attach time. */
export interface DockerExecTarget {
  containerId: string;
}

/**
 * The exit code is read by polling ExecInspect after the hijacked stream
 * closes: the daemon publishes Running→false with the integer code a beat
 * AFTER it EOFs the stream, and under load that beat stretches. So we wait for
 * an honest numeric code rather than trusting the first inspect — a 1s budget
 * proved too short (a loaded first-exec saw Running:true across the whole
 * window and fabricated a 1 for a command that had cleanly exited). Only when
 * the budget is genuinely exhausted do we fall back to 1 (the kube arm's same
 * no-honest-code posture).
 *
 * When the client disconnected first (dispose ⇒ we destroy the socket), the
 * code reaches no one and docker keeps the detached exec running, so a long
 * wait would only hold the control-plane session open for nothing — settle
 * fast on that path instead.
 */
export interface DockerExitPollOptions {
  intervalMs: number;
  /** Natural guest exit — wait generously for the honest code. */
  attempts: number;
  /** Client already gone (disposed) — settle fast, the code is moot. */
  disposedAttempts: number;
}

const DEFAULT_EXIT_POLL: DockerExitPollOptions = {
  intervalMs: 50,
  attempts: 100,
  disposedAttempts: 5,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the exec create body. NO identity wrapper on this substrate: the
 * container already runs as `node` with CapDrop:ALL + no-new-privileges
 * (setpriv would EPERM), exec defaults to the container's user (pinned
 * explicitly anyway), HOME comes from the passwd row (runc fills it for
 * spawn AND exec — build-gated in the agent image), and the container's
 * create-time env — the gateway proxy credential included — is inherited
 * by every exec. Only USER/LOGNAME need setting: no login step sets them.
 */
export const buildDockerExecConfig = (
  request: RelayRequest,
  tty: boolean,
): ExecCreateConfig => ({
  AttachStdin: true,
  AttachStdout: true,
  // The daemon refuses stderr alongside a TTY the same way the K8s API
  // server does — the TTY stream carries both.
  AttachStderr: !tty,
  Tty: tty,
  User: "node",
  // HOME is set explicitly (not left to the passwd row) so a sandbox created
  // before the durable-home image change (#932 usermod -d /workspace/.home)
  // — a supported state, e.g. a not-yet-restarted container after an upgrade
  // — still lands in the durable home instead of /home/node. This mirrors the
  // kube arm, whose identity wrapper sets HOME=AGENT_POSIX_HOME explicitly.
  Env: [`HOME=${AGENT_POSIX_HOME}`, "USER=node", "LOGNAME=node"],
  Cmd: ["sh", "-c", buildGuestPayload(request)],
});

export const createDockerExecBackend = (
  engine: DockerEngineApi,
  pollOptions: DockerExitPollOptions = DEFAULT_EXIT_POLL,
): ExecBackend<DockerExecTarget> => ({
  async exec(target, request, io, tty) {
    const execId = await engine.execCreate(
      target.containerId,
      buildDockerExecConfig(request, tty),
    );
    const socket = await engine.execStart(execId, tty);

    let settled = false;
    // Set when the relay disposes us (client disconnect) — switches the exit
    // poll to its fast, code-is-moot budget.
    let disposed = false;
    let resolveExit: (code: number) => void = () => undefined;
    let rejectExit: (error: Error) => void = () => undefined;
    const exited = new Promise<number>((resolve, reject) => {
      resolveExit = (code) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      rejectExit = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
    });

    // Client→daemon stdin is unframed in both modes. On the !TTY arm a
    // stdin EOF half-closes the hijacked connection (FIN), which the daemon
    // turns into a guest stdin EOF (moby's CloseStdin && !TTY law) — the
    // scp/exec semantics the relay needs; never destroy() to signal EOF.
    // On the TTY arm the FIN must NOT ride through: moby ignores stdin EOF
    // for a PTY (the session ends when the shell exits), but a client-side
    // FIN tears the whole hijacked attach down and the PTY's output with it
    // (proven against a real daemon) — so a PTY's stdin EOF ends nothing.
    io.stdin.pipe(socket, { end: !tty });

    // Backpressure daemon→client: a fast guest (a large scp/sftp download)
    // writing faster than a slow SSH client drains would otherwise buffer the
    // whole transfer in this process's memory. When a sink reports it is full
    // (write() === false), pause the hijacked socket and resume on 'drain'.
    const pipeWithBackpressure = (sink: Writable, chunk: Buffer): void => {
      if (!sink.write(chunk)) {
        socket.pause();
        sink.once("drain", () => socket.resume());
      }
    };

    if (tty) {
      // Raw stream: the PTY carries stdout and stderr merged.
      socket.on("data", (chunk: Buffer) => {
        pipeWithBackpressure(io.stdout, chunk);
      });
    } else {
      const demuxer = createDockerStreamDemuxer({
        stdout: io.stdout,
        stderr: io.stderr ?? io.stdout,
        onBackpressure: (sink) => {
          socket.pause();
          sink.once("drain", () => socket.resume());
        },
      });
      socket.on("data", (chunk: Buffer) => {
        demuxer.write(chunk);
      });
    }

    socket.on("error", (error: Error) => {
      rejectExit(
        new ExecDisconnectedError(`exec transport error: ${error.message}`),
      );
    });
    // Listeners are wired — release the output the engine paused at the
    // 101 (see execStart): nothing the guest wrote in the dial window is
    // lost.
    socket.resume();

    socket.on("close", () => {
      // A close means the stream ended — either the guest exited (clean) or
      // the relay disposed us (client disconnect / session close). Fetch the
      // exit code, briefly riding out the daemon's Running→false settling;
      // skip the poll once `exited` has already settled (dispose after a
      // normal exit).
      void (async () => {
        const attempts = disposed
          ? pollOptions.disposedAttempts
          : pollOptions.attempts;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (settled) return;
          let inspected;
          try {
            inspected = await engine.execInspect(execId);
          } catch (error) {
            rejectExit(
              new ExecDisconnectedError(
                `exec inspect failed after stream close: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );
            return;
          }
          // The honest terminal state: finished AND carrying an integer code.
          // A finished exec whose code has not landed yet (Running:false,
          // ExitCode:null — a transient some daemons expose) is NOT honest, so
          // keep polling rather than fabricate a code from the null.
          if (!inspected.Running && inspected.ExitCode !== null) {
            resolveExit(inspected.ExitCode);
            return;
          }
          await sleep(pollOptions.intervalMs);
        }
        // Budget exhausted: still running (a disposed exec docker keeps alive
        // after we detach) or a code that never landed. No honest value —
        // collapse to 1, the kube arm's same no-honest-code posture.
        resolveExit(1);
      })();
    });

    return {
      exited,
      ...(tty && {
        resize: (cols: number, rows: number) => {
          engine.execResize(execId, rows, cols).catch((error: unknown) => {
            log.debug({ err: error }, "exec resize failed");
          });
        },
      }),
      // Free the hijacked transport. For a TTY exec (whose stdin-EOF is
      // deliberately not propagated) this is the ONLY thing that ends the
      // attach when the SSH channel closes for any reason other than the
      // guest exiting; destroying the socket fires 'close' above, which
      // settles `exited`. Marking `disposed` first switches that poll to its
      // fast budget — the client is gone, the code reaches no one. Idempotent —
      // destroy() on an already-destroyed socket is a no-op.
      dispose: () => {
        disposed = true;
        socket.destroy();
      },
    };
  },
});
