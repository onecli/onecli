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
  registerSignalCleanup,
  runSignalCleanup,
  runSupervisor,
} from "./supervisor";
import { alignChromePolicyProxy, bootDesktop } from "./desktop";

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
  // The runner channel's bootstrap token is single-use and lives in `config`
  // from here on. Every process this one starts (the harness, the agent's
  // shells, background processes, a schedule's check) inherits this
  // environment, and none of them may hold the platform's channel
  // credential, spent or not.
  delete process.env.SANDBOX_WS_TOKEN;
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
  // has one (probed, never assumed). Best-effort: a sandbox whose desktop
  // fails to come up runs without one, as an image without the pieces does.
  // Taken down on both exits: the signal path and the clean one (after the
  // loop).
  //
  // NOT awaited here: it takes seconds, and the runner channel, the ready
  // signal and the first turn do not need it. The supervisor gets the start
  // as `pending`; the harness launches at once and its sessions receive the
  // display through their session environment when the start settles, so
  // only what must INHERIT `DISPLAY` from this process waits on it (a
  // scheduled gate's shell, preview relaunches).
  //
  // The hosted platform layers its agent desktop on top (licensed code,
  // loaded only when the hosted runner says so and it can carry the screen).
  const hosted =
    config.hostedDesktop && config.previews
      ? (await import("./ee/desktop")).createHostedDesktop(config.homeDir)
      : undefined;
  if (hosted) log("info", "hosted desktop on");
  const desktop = bootDesktop(hosted?.layer, registerSignalCleanup);
  const pending = desktop.started.then((desktopStarted) => ({
    addon: hosted?.addon(desktopStarted),
  }));

  try {
    await runSupervisor(config, harness, selectTransport(config), {
      pending,
    });
  } finally {
    desktop.close();
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
