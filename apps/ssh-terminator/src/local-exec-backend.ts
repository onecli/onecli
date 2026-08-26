import { spawn } from "node:child_process";
import type { ExecBackend } from "./backend/types";
import { buildGuestPayload } from "./relay";

/**
 * Test twin of a real substrate backend: runs the shared guest payload as a
 * local child process (`sh -c <script>`). The guest paths in the payload do
 * not exist on a dev machine, so the e2e suite rewrites them via
 * `mapCommand`.
 */

export interface LocalExecBackendOptions {
  mapCommand?: (command: string[]) => string[];
}

export const createLocalExecBackend = <T>(
  options: LocalExecBackendOptions = {},
): ExecBackend<T> => ({
  exec(_target, request, io) {
    const command = ["sh", "-c", buildGuestPayload(request)];
    const argv = options.mapCommand ? options.mapCommand(command) : command;
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

    return Promise.resolve({
      exited,
      // Kill the child when the SSH channel ends before it exits (the relay
      // calls dispose() unconditionally; killing an already-exited child is a
      // harmless no-op).
      dispose: () => {
        child.kill();
      },
    });
  },
});
