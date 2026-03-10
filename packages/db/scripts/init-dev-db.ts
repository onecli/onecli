import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile, mkdir, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve paths — works both in monorepo and Docker container
const monorepoDataDir = join(
  __dirname,
  "..",
  "..",
  "..",
  "apps",
  "web",
  "data",
  "pglite",
);
const dockerDataDir = "/app/data/pglite";
const monorepoMigrationsDir = join(__dirname, "..", "prisma", "migrations");
const dockerMigrationsDir = "/app/packages/db/prisma/migrations";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const migrationsDir = (await exists(monorepoMigrationsDir))
  ? monorepoMigrationsDir
  : dockerMigrationsDir;

const monorepoWebDir = join(__dirname, "..", "..", "..", "apps", "web");
const dataDir = (await exists(monorepoWebDir))
  ? monorepoDataDir
  : dockerDataDir;

console.log("Initializing PGlite dev database...");
console.log("  Data dir:", dataDir);
console.log("  Migrations:", migrationsDir);

await mkdir(dataDir, { recursive: true });

const pglite = new PGlite(dataDir);

const dirs = (await readdir(migrationsDir))
  .filter((d: string) => !d.startsWith("migration_lock"))
  .sort();

for (const dir of dirs) {
  const sql = await readFile(
    join(migrationsDir, dir, "migration.sql"),
    "utf-8",
  );
  try {
    await pglite.exec(sql);
    console.log(`  Applied: ${dir}`);
  } catch {
    console.log(`  Skipped: ${dir} (already applied)`);
  }
}

// Bootstrap local-mode user so the app works immediately on first start
const localUser = await pglite.query(
  `SELECT id FROM "User" WHERE "externalAuthId" = 'local-admin'`,
);
if (localUser.rows.length === 0) {
  const id = `usr_${[...Array(24)].map(() => Math.random().toString(36)[2]).join("")}`;
  await pglite.exec(`
    INSERT INTO "User" (id, "externalAuthId", email, name, "createdAt", "updatedAt")
    VALUES ('${id}', 'local-admin', 'admin@localhost', 'Admin', NOW(), NOW())
  `);
  console.log("  Created local-admin user");
}

await pglite.close();
console.log("Done! PGlite database is ready.");
