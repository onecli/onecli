import {
  KNOWN_AGENT_HARNESSES,
  type Harness,
  type SupervisorTransport,
} from "@onecli/agent-protocol";
import { loadConfig, type SupervisorConfig } from "./config";
import { createFakeHarness } from "./harness/fake";
import { createJcodeHarness } from "./harness/jcode";
import { log } from "./log";
import {
  gatewayFromProxyUrl,
  publishOpenProxyUrl,
  startOpenProxy,
} from "./open-proxy";
import { createStdioTransport } from "./transport/stdio";
import { createWsTransport } from "./transport/ws";
import {
  runSignalCleanup,
  runSupervisor,
  registerSignalCleanup,
} from "./supervisor";
import {
  alignChromePolicyProxy,
  desktopAvailable,
  publishDisplay,
  startDesktop,
} from "./desktop";
import type { SupervisorAddon } from "./addons";

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
  if (!config.bootstrapToken || !config.sandboxId) {
    throw new Error(
      "RUNNER_WS_URL is set but SANDBOX_WS_TOKEN or SANDBOX_ID is missing — the runner channel cannot be authenticated.",
    );
  }
  return createWsTransport({
    url: config.runnerWsUrl,
    token: config.bootstrapToken,
    sandboxId: config.sandboxId,
  });
};

// The one sanctioned adapter-id mapping (invariant 9): ids resolve to
// implementations here and nowhere else. Unset means the default (the real
// adapter — AGENT_HARNESS is optional), but a SET-and-unknown id throws
// instead of silently booting the default: a typo'd env would otherwise run
// the wrong harness with no trace beyond a log line nobody is watching.
const HARNESS_REGISTRY: Record<string, () => Harness> = {
  jcode: createJcodeHarness,
  fake: createFakeHarness,
};

const selectHarness = (config: SupervisorConfig): Harness => {
  const id = config.harness ?? "jcode";
  // `Object.hasOwn`, not bare bracket access: bracket access walks the
  // prototype chain, so AGENT_HARNESS="constructor" would dodge the throw
  // and boot garbage (the registry-lookup trap the api's registries pin).
  const create = Object.hasOwn(HARNESS_REGISTRY, id)
    ? HARNESS_REGISTRY[id]
    : undefined;
  if (!create) {
    throw new Error(
      `Unknown AGENT_HARNESS "${config.harness}" — expected one of: ${KNOWN_AGENT_HARNESSES.join(", ")}.`,
    );
  }
  return create();
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const harness = selectHarness(config);

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

  // The open proxy (open-proxy.ts): the loopback door onto the gateway's
  // open lane, for browsers and anything else that must keep its own TLS.
  // Started BEFORE the harness so `OPEN_PROXY` is in the environment every
  // child inherits (the harness daemon, its shells, background processes):
  // the agent reads the variable, never a number. Best-effort, like the CA
  // import in the entrypoint: a sandbox without a gateway URL (local dev)
  // or with no free port simply has no open proxy, and the supervisor comes
  // up regardless. The agent learns the absence the same way it learns
  // everything else here, from the environment.
  const gateway = gatewayFromProxyUrl(process.env.HTTPS_PROXY);
  if (gateway) {
    try {
      const openProxy = await startOpenProxy(gateway);
      process.env.OPEN_PROXY = openProxy.url;
      publishOpenProxyUrl(openProxy.url);
      alignChromePolicyProxy(openProxy.url);
      log("info", "open proxy listening", { url: openProxy.url });
    } catch (error) {
      log("warn", "open proxy did not start", { error: String(error) });
    }
  } else {
    log("info", "open proxy not started: no gateway proxy URL in HTTPS_PROXY");
  }

  // The desktop (desktop.ts): a screen with a window manager, for a browser
  // that runs the way it does on a person's computer. Only where the image
  // has one (probed, never assumed); started BEFORE the harness for the
  // same reason as the open proxy, so `DISPLAY` is in the environment every
  // child inherits. Best-effort: a sandbox whose desktop fails to come up
  // runs without one, as an image without the pieces does. Taken down on
  // both exits: the signal path (below) and the clean one (after the loop).
  //
  // The hosted platform layers its agent desktop on top (licensed code,
  // loaded only when the hosted runner says so and it can carry the screen).
  const hosted =
    config.hostedDesktop && config.previews
      ? (await import("./ee/desktop")).createHostedDesktop(config.homeDir)
      : undefined;
  if (hosted) log("info", "hosted desktop on");
  let closeDesktop = () => {};
  let desktopStarted = false;
  if (desktopAvailable(process.env)) {
    try {
      const desktop = await startDesktop(process.env, hosted?.layer);
      process.env.DISPLAY = desktop.display;
      if (desktop.dbusAddress) {
        process.env.DBUS_SESSION_BUS_ADDRESS = desktop.dbusAddress;
      }
      publishDisplay(desktop.display);
      closeDesktop = () => desktop.close();
      registerSignalCleanup(closeDesktop);
      desktopStarted = true;
      log("info", "desktop ready", { display: desktop.display });
    } catch (error) {
      log("warn", "desktop did not start", { error: String(error) });
    }
  } else {
    log("info", "desktop not started: this image has no window manager");
  }
  const addon: SupervisorAddon | undefined = hosted?.addon(desktopStarted);

  try {
    await runSupervisor(config, harness, selectTransport(config), { addon });
  } finally {
    closeDesktop();
  }
  log("info", "supervisor exited cleanly");
  // END THE PROCESS, explicitly. This process is the sandbox's whole
  // lifetime (the container runs as long as it does), and a finished run has
  // already torn down everything it owns (runSupervisor's `finally`). Left to
  // the event loop, ONE handle nothing here owns keeps it alive: a runner
  // socket whose close never completed has kept a sandbox, and everything it
  // holds, running indefinitely after its run ended. The signal path above
  // already exits this way; the crash path below does too.
  process.exit(0);
};

main().catch((error: unknown) => {
  log("error", "supervisor crashed", { error: String(error) });
  process.exit(1);
});
