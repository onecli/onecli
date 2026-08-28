import { PrismaClient } from "@prisma/client";

import { closeAdminClient } from "./db.js";
import { e2eConfig } from "./env.js";

/**
 * Prepare the template database every test clones.
 *
 * Migrating it is CI's job (and the README's, locally) because that needs the
 * Prisma CLI. What happens here is verification and freezing:
 *
 *  - verify the schema is actually present, so an unmigrated template fails once
 *    with a usable message instead of failing every test confusingly;
 *  - freeze it with `ALLOW_CONNECTIONS false`, the same trick `template0` uses,
 *    so no stray session can block `CREATE DATABASE … TEMPLATE …` and no test can
 *    mutate the source of truth.
 */

const allowConnections = async (
  admin: PrismaClient,
  templateDb: string,
  allowed: boolean,
): Promise<void> => {
  await admin.$executeRawUnsafe(
    `ALTER DATABASE "${templateDb}" WITH ALLOW_CONNECTIONS ${allowed ? "true" : "false"}`,
  );
};

export default async function setup(): Promise<() => Promise<void>> {
  const config = e2eConfig();
  // `null` means a local run without infrastructure; every scenario skips and
  // there is nothing to prepare. In CI `e2eConfig()` throws instead.
  if (config === null) return async () => undefined;

  const admin = new PrismaClient({ datasourceUrl: config.adminDatabaseUrl });

  // Drop databases stranded by a previous run that was killed mid-test. Safe
  // here because it happens before any test creates one; doing it at teardown
  // would race a concurrently running suite.
  const stale = await admin.$queryRawUnsafe<Array<{ datname: string }>>(
    `SELECT datname FROM pg_database WHERE datname LIKE 'e2e\\_%'`,
  );
  for (const { datname } of stale) {
    await admin
      .$executeRawUnsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
      .catch(() => undefined);
  }
  if (stale.length > 0) {
    console.warn(
      `swept ${String(stale.length)} database(s) left by an earlier run`,
    );
  }

  // Open it just long enough to look, then close it again.
  await allowConnections(admin, config.templateDb, true);

  const templateUrl = new URL(config.adminDatabaseUrl);
  templateUrl.pathname = `/${config.templateDb}`;
  const template = new PrismaClient({ datasourceUrl: templateUrl.toString() });

  try {
    const rows = await template.$queryRawUnsafe<
      Array<{ present: string | null }>
    >(`SELECT to_regclass('public.workspaces')::text AS present`);
    if (rows[0]?.present == null) {
      throw new Error(
        `the template database "${config.templateDb}" exists but has no schema. Migrate it:\n` +
          `  DATABASE_URL=${templateUrl.toString()} pnpm --filter @onecli/db exec prisma migrate deploy`,
      );
    }
  } finally {
    await template.$disconnect();
  }

  await allowConnections(admin, config.templateDb, false);
  await admin.$disconnect();

  return async () => {
    await closeAdminClient();
  };
}
