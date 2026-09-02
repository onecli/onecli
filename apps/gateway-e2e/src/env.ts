/**
 * The suite's required environment, resolved once, and the ONE skip guard.
 *
 * The guard is the whole reason this package exists in the shape it does. The
 * Rust integration tests it replaces skipped silently whenever their env was
 * unset — and CI never set it — so 8 tests reported green across 5 edition lanes
 * while executing nothing. Here, a missing variable is tolerated **only** on a
 * developer machine. Under `CI` it throws, because a proxy regression slipping
 * through unnoticed is precisely the failure this suite exists to prevent.
 *
 * Deliberately NOT skippable anywhere, including locally: a missing or
 * wrong-edition binary, an unmigrated template database, or infrastructure that
 * is unreachable when its URL *is* set. Those are wiring bugs, not absent
 * dependencies, and they must be loud.
 */

/** Everything the suite needs to stand up a gateway and talk to it. */
export interface E2EConfig {
  /** Maintenance connection used to CREATE/DROP a database per test. */
  readonly adminDatabaseUrl: string;
  /** Name of the migrated, frozen database each test clones. */
  readonly templateDb: string;
  readonly redisHost: string;
  readonly redisPort: string;
}

const read = (name: string): string | undefined => {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : undefined;
};

/** Why each variable is needed, surfaced in the failure message. */
const WHY: Readonly<Record<string, string>> = {
  E2E_ADMIN_DATABASE_URL:
    "the maintenance connection used to clone a database per test",
  E2E_TEMPLATE_DB: "the migrated template database each test clones",
  E2E_REDIS_HOST:
    "the enterprise lane runs the licensed Redis-backed stores (HA is licensed)",
};

const resolve = (): E2EConfig | null => {
  // Read each explicitly rather than looping, so the returned object needs no
  // non-null assertions — the compiler narrows these for us.
  const adminDatabaseUrl = read("E2E_ADMIN_DATABASE_URL");
  const templateDb = read("E2E_TEMPLATE_DB");
  const redisHost = read("E2E_REDIS_HOST");

  const missing = Object.entries({
    E2E_ADMIN_DATABASE_URL: adminDatabaseUrl,
    E2E_TEMPLATE_DB: templateDb,
    E2E_REDIS_HOST: redisHost,
  })
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);

  if (
    adminDatabaseUrl === undefined ||
    templateDb === undefined ||
    redisHost === undefined
  ) {
    const first = missing[0] ?? "E2E_ADMIN_DATABASE_URL";
    if (process.env.CI !== undefined) {
      throw new Error(
        `${first} must be set in CI: the gateway E2E suite must not silently skip ` +
          `(${WHY[first] ?? "required by the suite"}). Missing: ${missing.join(", ")}`,
      );
    }
    console.warn(
      `skipping gateway E2E: ${missing.join(", ")} unset — see apps/gateway-e2e/README.md`,
    );
    return null;
  }

  return {
    adminDatabaseUrl,
    templateDb,
    redisHost,
    redisPort: read("E2E_REDIS_PORT") ?? "6379",
  };
};

let cached: E2EConfig | null | undefined;

/** Resolved config, or `null` when the suite should skip (never `null` in CI). */
export const e2eConfig = (): E2EConfig | null => {
  if (cached === undefined) cached = resolve();
  return cached;
};

/**
 * The shared symmetric key every process in a scenario encrypts/decrypts
 * with — pinned by vitest.config.ts `test.env`, so the fixtures (this process)
 * and the spawned gateway agree on it. A fixed test key, never a production
 * value.
 */
export const secretEncryptionKey = (): string => {
  const value = read("SECRET_ENCRYPTION_KEY");
  if (value === undefined) {
    throw new Error(
      "SECRET_ENCRYPTION_KEY missing — vitest.config.ts pins it; run through vitest.",
    );
  }
  return value;
};
