import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The suite's required environment, resolved once, and the ONE skip guard —
 * the gateway-e2e law verbatim: a missing variable is tolerated only on a
 * developer machine; under `CI` it throws, because the hosted spine silently
 * skipping is exactly the failure this suite exists to prevent (the hand-run
 * dev proof scripts it replaces rotted precisely because nothing ran them).
 */

export interface HostedE2EConfig {
  /** Maintenance connection used to CREATE/DROP a database per test. */
  readonly adminDatabaseUrl: string;
  /** Name of the migrated, frozen database each test clones. */
  readonly templateDb: string;
  /** The agent sandbox image the runner spawns. */
  readonly agentImage: string;
  readonly dockerSocket: string;
  /**
   * How a sandbox container addresses processes on the HOST (the per-test
   * gateway and the in-process runner's control channel). Docker Desktop
   * resolves `host.docker.internal` natively; plain Linux gets it via the
   * runner's ExtraHosts `host-gateway` entry (set alongside this).
   */
  readonly hostGatewayHost: string;
  /**
   * Optional Redis for the spawned gateway (the licensed HA stores). Set in
   * CI so the enterprise lane runs the canonical Redis-backed deployment;
   * unset locally the entitled gateway falls back to its in-memory stores —
   * a legitimate licensed configuration, so nothing skips.
   */
  readonly redisHost: string | undefined;
  readonly redisPort: string;
}

const read = (name: string): string | undefined => {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : undefined;
};

const WHY: Readonly<Record<string, string>> = {
  E2E_ADMIN_DATABASE_URL:
    "the maintenance connection used to clone a database per test",
  E2E_TEMPLATE_DB: "the migrated template database each test clones",
};

const resolve = (): HostedE2EConfig | null => {
  const adminDatabaseUrl = read("E2E_ADMIN_DATABASE_URL");
  const templateDb = read("E2E_TEMPLATE_DB");

  const missing = Object.entries({
    E2E_ADMIN_DATABASE_URL: adminDatabaseUrl,
    E2E_TEMPLATE_DB: templateDb,
  })
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);

  if (adminDatabaseUrl === undefined || templateDb === undefined) {
    const first = missing[0] ?? "E2E_ADMIN_DATABASE_URL";
    if (process.env.CI !== undefined) {
      throw new Error(
        `${first} must be set in CI: the hosted E2E suite must not silently skip ` +
          `(${WHY[first] ?? "required by the suite"}). Missing: ${missing.join(", ")}`,
      );
    }
    console.warn(
      `skipping hosted E2E: ${missing.join(", ")} unset — see apps/hosted-e2e/README.md`,
    );
    return null;
  }

  return {
    adminDatabaseUrl,
    templateDb,
    agentImage: read("E2E_AGENT_IMAGE") ?? "onecli-agent:dev",
    dockerSocket: read("E2E_DOCKER_SOCKET") ?? "/var/run/docker.sock",
    hostGatewayHost: read("E2E_HOST_GATEWAY_HOST") ?? "host.docker.internal",
    redisHost: read("E2E_REDIS_HOST"),
    redisPort: read("E2E_REDIS_PORT") ?? "6379",
  };
};

let cached: HostedE2EConfig | null | undefined;

/** Resolved config, or `null` when the suite should skip (never in CI). */
export const e2eConfig = (): HostedE2EConfig | null => {
  if (cached === undefined) cached = resolve();
  return cached;
};

/**
 * The gateway binary, resolved like gateway-e2e's: an explicit env wins, then
 * the sibling crate's build outputs. A missing binary is a hard throw, never
 * a skip — an unbuilt gateway is a wiring bug.
 */
export const gatewayBinary = (): string => {
  const explicit = read("E2E_GATEWAY_BIN");
  if (explicit !== undefined) {
    if (!existsSync(explicit)) {
      throw new Error(`E2E_GATEWAY_BIN points at nothing: ${explicit}`);
    }
    return explicit;
  }
  const root = join(import.meta.dirname, "..", "..", "gateway", "target");
  for (const profile of ["debug", "release"]) {
    const candidate = join(root, profile, "onecli-gateway");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "cannot find the onecli-gateway binary. Build it first:\n" +
      "  cargo build --manifest-path apps/gateway/Cargo.toml --bin onecli-gateway\n" +
      "or set E2E_GATEWAY_BIN to an existing binary.",
  );
};

/** The shared symmetric key every process in a scenario encrypts/decrypts
 * with — pinned by vitest.config.ts `test.env`. */
export const secretEncryptionKey = (): string => {
  const value = read("SECRET_ENCRYPTION_KEY");
  if (value === undefined) {
    throw new Error(
      "SECRET_ENCRYPTION_KEY missing — vitest.config.ts pins it; run through vitest.",
    );
  }
  return value;
};
