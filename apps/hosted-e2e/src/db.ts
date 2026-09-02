import { PrismaClient } from "@prisma/client";

import type { HostedE2EConfig as E2EConfig } from "./env.js";
import type { TestIds } from "./ids.js";

/**
 * A private Postgres database per test, cloned from a migrated template.
 *
 * Cloning rather than migrating keeps setup to roughly a file copy, and because
 * the template is frozen with `ALLOW_CONNECTIONS false` no test can mutate the
 * source of truth and no stray session can block a clone.
 *
 * Note this isolates rows only. Redis is shared and never flushed, which is why
 * every test also draws unique org/workspace/agent ids — see `ids.ts`.
 */
export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  readonly prisma: PrismaClient;
  drop(): Promise<void>;
}

const databaseUrlFor = (adminUrl: string, name: string): string => {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

/** Admin client, reused across tests in this process. */
let admin: PrismaClient | undefined;
const adminClient = (config: E2EConfig): PrismaClient => {
  admin ??= new PrismaClient({ datasourceUrl: config.adminDatabaseUrl });
  return admin;
};

/**
 * `CREATE DATABASE … TEMPLATE …` takes a lock on the source, and vitest runs each
 * test file in its own fork — so contention is across processes and a retry is
 * the only thing that can resolve it.
 */
const withRetry = async (attempt: () => Promise<void>): Promise<void> => {
  let lastError: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      await attempt();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  throw lastError;
};

export const createTestDatabase = async (
  ids: TestIds,
  config: E2EConfig,
): Promise<TestDatabase> => {
  const client = adminClient(config);
  const { database } = ids;

  const create = async (): Promise<void> => {
    await client.$executeRawUnsafe(
      `CREATE DATABASE "${database}" TEMPLATE "${config.templateDb}"`,
    );
  };
  await withRetry(create);

  const url = databaseUrlFor(config.adminDatabaseUrl, database);
  const prisma = new PrismaClient({ datasourceUrl: url });

  return {
    name: database,
    url,
    prisma,
    drop: async () => {
      await prisma.$disconnect();
      if (process.env.HOSTED_E2E_KEEP_DB !== undefined) {
        console.log(`kept database for inspection: ${url}`);
        return;
      }
      // FORCE terminates any lingering backend (the gateway's pool holds up to
      // five). Postgres 13+; CI and the documented local setup both run 18.
      await client
        .$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
        .catch((error: unknown) => {
          console.warn(`leaked database ${database}: ${String(error)}`);
        });
    },
  };
};

/** Close the shared admin client. Called from global teardown. */
export const closeAdminClient = async (): Promise<void> => {
  await admin?.$disconnect();
  admin = undefined;
};
