import { PrismaClient } from "@prisma/client";
import { e2eConfig } from "./env.js";
import { closeAdminClient } from "./db.js";
import { assertDockerReady, sweepStaleRuns } from "./docker.js";

/**
 * Once per run: verify + freeze the template database (the gateway-e2e
 * mechanics), sweep leftovers a KILLED prior run stranded — its `he2e_%`
 * databases AND its Docker objects (containers/volumes by the pinned name
 * prefix, per-test networks by theirs) — and assert the Docker daemon + the
 * agent image are usable, once and loudly, never per-test.
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
  if (config === null) return async () => undefined;

  await assertDockerReady(config.agentImage);
  await sweepStaleRuns();

  const admin = new PrismaClient({ datasourceUrl: config.adminDatabaseUrl });

  const stale = await admin.$queryRawUnsafe<Array<{ datname: string }>>(
    `SELECT datname FROM pg_database WHERE datname LIKE 'he2e\\_%'`,
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
