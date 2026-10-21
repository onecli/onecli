import { DaemonAlreadyRunning, main } from "./daemon";

// The daemon's entry: `node dist/browser-driver/daemon.mjs`. Spawned by the
// command when no daemon answers; nothing else starts it. Losing the race
// to another daemon is the expected outcome for one of two cold-start
// commands, and a quiet exit: the command retries against the winner.
main().catch((error: unknown) => {
  if (error instanceof DaemonAlreadyRunning) process.exit(0);
  process.stderr.write(`browser driver failed to start: ${String(error)}\n`);
  process.exit(1);
});
