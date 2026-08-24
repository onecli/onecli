import { loadConfig, ConfigError } from "./config";
import { ControlPlaneError, createControlPlane } from "./control-plane";
import { createAdapter } from "./adapter";

/**
 * Composition root — the runner's shape: config errors exit 2 immediately;
 * registration retries TRANSPORT failures forever (the control plane may
 * still be booting) but exits on an ANSWERED 401 (retrying a bad token hides
 * a misconfiguration); SIGTERM/SIGINT drain briefly and exit 0.
 */

const log = (message: string, detail?: unknown): void => {
  const stamp = new Date().toISOString();
  if (detail !== undefined) {
    console.log(`${stamp} channel-adapter: ${message}`, detail);
  } else {
    console.log(`${stamp} channel-adapter: ${message}`);
  }
};

const REGISTER_RETRY_MAX_MS = 10_000;

const main = async (): Promise<void> => {
  const config = loadConfig(process.env);
  if (config.appUrlFromLegacyBind) {
    log(
      "ONECLI_BIND_HOST is seeding the dashboard URL (deprecated, removed " +
        `next major). Pin it: add ONECLI_EXTERNAL_URL=${config.appUrl} to ` +
        "the .env beside docker-compose.yml.",
    );
  }
  const controlPlane = createControlPlane({
    baseUrl: config.controlPlaneUrl,
    token: config.token,
  });

  let backoff = 1_000;
  for (;;) {
    try {
      const adapterId = await controlPlane.register(config.name);
      log("registered", { adapterId });
      break;
    } catch (err) {
      if (err instanceof ControlPlaneError) {
        // The control plane ANSWERED and refused — a bad token, not a race.
        throw err;
      }
      log(`control plane unreachable; retrying in ${backoff}ms`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, REGISTER_RETRY_MAX_MS);
    }
  }

  const adapter = createAdapter({ config, controlPlane, log });
  await adapter.start();
  log("running", {
    controlPlane: config.controlPlaneUrl,
    gateway: config.gatewayUrl,
  });

  const shutdown = (signal: string): void => {
    log(`${signal} received; draining`);
    adapter.stop();
    // Bounded drain: in-flight Slack posts get a moment, then we go — the
    // control-plane ledgers (dedupe, cursors, prompts) make a hard exit
    // safe. Deliberately NOT unref'd: this timer is what guarantees exit.
    setTimeout(() => process.exit(0), 3_000);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`channel-adapter: ${err.message}`);
    process.exit(2);
  }
  console.error("channel-adapter: fatal", err);
  process.exit(1);
});
