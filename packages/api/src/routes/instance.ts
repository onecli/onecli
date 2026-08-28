import { Hono } from "hono";
import { EDITION_INFO, SSH_HOST, SSH_PORT } from "../lib/env";
import { isEntitled } from "../lib/entitlements";
import { resolveOriginsFromEnv } from "../lib/public-origins";
import { getRunnerAvailability } from "../services/runner-service";
import { sshAvailable } from "../services/ssh-service";

/**
 * Instance metadata — the browser's only source of runtime truth the client
 * bundle cannot know: the edition and the enterprise entitlement are runtime
 * env on the server, while everything `NEXT_PUBLIC_*` is baked at build time
 * into prebuilt self-host images. Unauthenticated by design, like `/health`:
 * it reveals deployment posture, never data.
 *
 * `runners` is the hosted-agents availability fact (§3.13): `registered`
 * gates the entrance — a deployment that never had a runner shows nothing —
 * and `online` is what lets the hosted surfaces say "offline" instead of
 * hiding agents that already exist. Same posture-not-data rule: two booleans
 * plus the declared home-durability CLASS (§3.9 — how agent files survive
 * sleep, stated rather than assumed), never runner identity.
 */
export const instanceRoutes = (version?: string) => {
  const app = new Hono();

  app.get("/", async (c) => {
    // Same posture-not-data rule as the rest of the body: these are the
    // addresses the deployment already advertises to every browser (the
    // layout injects two of them into each page), never internal ones.
    const origins = resolveOriginsFromEnv();
    return c.json({
      edition: EDITION_INFO.edition,
      entitled: isEntitled(),
      version: version ?? "unknown",
      runners: await getRunnerAvailability(),
      // `external` IS the app origin (no duplicate `app` twin on the wire).
      // `mode` names the DERIVATION rule only — the explicit fields are
      // authoritative (cloud, for one, is https with split-host overrides:
      // mode says "proxy" while gateway is its own host, not external+/gw).
      origins: {
        external: origins.external,
        api: origins.api,
        gateway: origins.gateway,
        mode: origins.mode,
      },
      // The SSH front door (sandbox-platform step 5): absent means "not on
      // this deployment" — the optional-field contract `runners` set. Only
      // the public DNS host and port, never CA or session facts. Cloud
      // advertises :22 (the NLB); self-host an unprivileged high port.
      ...(sshAvailable() ? { ssh: { host: SSH_HOST, port: SSH_PORT } } : {}),
    });
  });

  return app;
};
