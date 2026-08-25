import { PassThrough } from "node:stream";
import { Exec, KubeConfig, type V1Status } from "@kubernetes/client-node";
import { logger } from "../../logger";
import { ExecDisconnectedError, type ExecBackend } from "../types";

const log = logger.child({ component: "exec-backend" });

/**
 * The kube substrate's exec backend: one byte pipe into the sandbox via the
 * Kubernetes API's `pods/exec` subresource. The target vocabulary below is
 * this backend's own — the core threads it opaquely.
 */

export interface KubeExecTarget {
  namespace: string;
  pod: string;
  container: string;
  /** The broker-minted per-session ServiceAccount token. */
  token: string;
  /** `https://host:port` of the API server. */
  server: string;
  /**
   * CA bundle file for the API server. The terminator pod runs with
   * automountServiceAccountToken: false, so the in-cluster default CA path
   * does not exist — the chart mounts the kube-root-ca ConfigMap instead.
   */
  caFile: string;
}

/**
 * Map the exec V1Status to a POSIX exit code. `Success` is 0; a non-zero
 * guest exit arrives as `Failure`/`NonZeroExitCode` with the code riding a
 * cause message. Any other failure shape (signal death, container gone) has
 * no honest code — collapse to 1.
 */
export const exitCodeOf = (status: V1Status): number => {
  if (status.status === "Success") return 0;
  if (status.reason === "NonZeroExitCode") {
    const cause = status.details?.causes?.find(
      (candidate) => candidate.reason === "ExitCode",
    );
    const code = Number(cause?.message);
    if (Number.isInteger(code) && code >= 0 && code <= 255) return code;
  }
  return 1;
};

/**
 * client-node wires the exec RESIZE channel only when the stdout stream it
 * receives looks like a TTY (`columns`/`rows` fields + a 'resize' event) —
 * this augmented PassThrough is the sanctioned bridge from ssh2's
 * window-change events.
 */
class ResizableStdout extends PassThrough {
  columns = 80;
  rows = 24;
}

/**
 * The transport has NO built-in keepalive and the NLB idles connections out
 * at ~350s — a quiet-but-open shell must be pinged under that.
 */
const PING_INTERVAL_MS = 25_000;

export const createKubeExecBackend = (): ExecBackend<KubeExecTarget> => ({
  async exec(target, command, io, tty) {
    // Per-session KubeConfig, built by hand: the pod holds no ServiceAccount
    // credentials (automount off), so loadFromCluster() has nothing to read —
    // trust is the mounted root CA file plus the broker-minted token.
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromClusterAndUser(
      {
        name: "terminator",
        server: target.server,
        caFile: target.caFile,
        skipTLSVerify: false,
      },
      { name: "ssh-session", token: target.token },
    );
    const exec = new Exec(kubeConfig);

    let settled = false;
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

    // Intermediates own the library's end() calls (it ends the streams it is
    // handed when the status arrives) so the ssh2 channel's lifecycle stays
    // with the relay: pipe without end propagation.
    const stdout = new ResizableStdout();
    stdout.pipe(io.stdout, { end: false });
    let stderr: PassThrough | null = null;
    if (io.stderr && !tty) {
      const sink = io.stderr;
      stderr = new PassThrough();
      stderr.pipe(sink, { end: false });
    }

    const ws = await exec.exec(
      target.namespace,
      target.pod,
      target.container,
      command,
      stdout,
      stderr,
      io.stdin,
      tty,
      (status) => resolveExit(exitCodeOf(status)),
    );

    const pinger = setInterval(() => {
      try {
        ws.ping();
      } catch (error) {
        log.debug({ err: error }, "exec ping failed");
      }
    }, PING_INTERVAL_MS);
    pinger.unref();

    ws.on("error", (error: Error) => {
      rejectExit(
        new ExecDisconnectedError(`exec transport error: ${error.message}`),
      );
    });
    ws.on("close", () => {
      clearInterval(pinger);
      // A close before any exit status is pod churn or a severed dial — an
      // honest relay_error, never a fabricated exit code.
      rejectExit(new ExecDisconnectedError("exec transport closed"));
    });
    void exited.catch(() => undefined).then(() => clearInterval(pinger));

    return {
      exited,
      ...(tty && {
        resize: (cols: number, rows: number) => {
          stdout.columns = cols;
          stdout.rows = rows;
          stdout.emit("resize");
        },
      }),
    };
  },
});
