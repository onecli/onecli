import type { SupervisorTransport } from "@onecli/agent-protocol";
import { loadConfig, type SupervisorConfig } from "./config";
import { createFakeHarness } from "./harness/fake";
import { createJcodeHarness } from "./harness/jcode";
import { log } from "./log";
import { createStdioTransport } from "./transport/stdio";
import { createWsTransport } from "./transport/ws";
import { runSignalCleanup, runSupervisor } from "./supervisor";

/**
 * Entrypoint of the in-sandbox supervisor. The ONLY place an adapter id maps
 * to an implementation — everything else speaks the vendor-neutral interface.
 */

/**
 * The transport is chosen the same way: a runner-spawned sandbox is handed a
 * control-channel URL and dials it; without one the supervisor speaks JSONL
 * on stdio, which is what the dev loop drives.
 */
const selectTransport = (config: SupervisorConfig): SupervisorTransport => {
  if (!config.runnerWsUrl) return createStdioTransport();
  if (!config.bootstrapToken) {
    throw new Error(
      "RUNNER_WS_URL is set but SANDBOX_WS_TOKEN is missing — the runner channel cannot be authenticated.",
    );
  }
  return createWsTransport({
    url: config.runnerWsUrl,
    token: config.bootstrapToken,
  });
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  // The one sanctioned adapter-id mapping (invariant 9): ids resolve to
  // implementations here and nowhere else. Default: the real adapter.
  const harness =
    config.harness === "fake" ? createFakeHarness() : createJcodeHarness();

  log("info", "supervisor starting", {
    harness: harness.id,
    homeDir: config.homeDir,
    model: config.model ?? null,
    transport: config.runnerWsUrl ? "ws" : "stdio",
  });

  // A stopped sandbox is a normal, expected state (§3.9), so SIGTERM must end
  // the process cleanly rather than being killed after the grace period.
  const onSignal = (signal: string) => {
    log("info", "supervisor received signal", { signal });
    // Give background children their flush chance before we go — this exit
    // skips the loop's finally, so the group-SIGTERM has to happen here.
    runSignalCleanup();
    process.exit(0);
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  await runSupervisor(config, harness, selectTransport(config));
  log("info", "supervisor exited cleanly");
};

main().catch((error: unknown) => {
  log("error", "supervisor crashed", { error: String(error) });
  process.exit(1);
});
