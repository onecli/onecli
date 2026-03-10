import { PrismaClient } from "@prisma/client";

// Construct DATABASE_URL from individual env vars (ECS/Secrets Manager)
if (!process.env.DATABASE_URL && process.env.DB_HOST) {
  const user = process.env.DB_USERNAME;
  const pass = encodeURIComponent(process.env.DB_PASSWORD ?? "");
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT ?? "5432";
  const name = process.env.DB_NAME;
  process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${name}`;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

async function createPGliteClient(): Promise<PrismaClient> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PrismaPGlite } = await import("pglite-prisma-adapter");

  const pglite = new PGlite("./data/pglite");

  const adapter = new PrismaPGlite(pglite);
  // Type assertion needed: pglite-prisma-adapter@0.6.1 pins @prisma/driver-adapter-utils
  // to a narrower version range than our Prisma version
  return new PrismaClient({ adapter: adapter as never });
}

async function initDb(): Promise<PrismaClient> {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;

  const isCloud = process.env.NEXT_PUBLIC_EDITION === "cloud";
  const client =
    isCloud || process.env.DATABASE_URL
      ? new PrismaClient()
      : await createPGliteClient();

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
  }

  return client;
}

export const db = await initDb();

export type { PrismaClient } from "@prisma/client";
export { Prisma, type User, type AuditLog } from "@prisma/client";
