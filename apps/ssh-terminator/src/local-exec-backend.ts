import { spawn } from "node:child_process";
import type { ExecBackend } from "./backend/types";

/**
 * Test twin of the Kubernetes exec backend: runs the relay's command as a
 * local child process. The real guest command is wrapped in the identity
 * drop (`env … setpriv … -- sh -c <script>`) which cannot run on a dev
 * machine, so by default everything through the `--` fence is stripped and
 * the trailing `sh -c <script>` runs locally — the e2e suite additionally
 * rewrites guest-only paths in the script via `mapCommand`.
 */

export interface LocalExecBackendOptions {
  mapCommand?: (command: string[]) => string[];
}

const stripIdentityWrapper = (command: string[]): string[] => {
  const fence = command.lastIndexOf("--");
  return fence >= 0 ? command.slice(fence + 1) : command;
};

export const createLocalExecBackend = <T>(
  options: LocalExecBackendOptions = {},
): ExecBackend<T> => ({
  exec(_target, command, io) {
    const argv = (options.mapCommand ?? stripIdentityWrapper)(command);
    const program = argv[0];
    if (!program) {
      return Promise.reject(new Error("empty exec command"));
    }
    const child = spawn(program, argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
    });

    io.stdin.pipe(child.stdin);
    child.stdout.on("data", (chunk: Buffer) => {
      io.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // With a TTY the real backend merges stderr into the main stream.
      (io.stderr ?? io.stdout).write(chunk);
    });

    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", (error) => reject(error));
      child.once("exit", (code, signal) => {
        resolve(code ?? (signal ? 1 : 0));
      });
    });

    return Promise.resolve({ exited });
  },
});
