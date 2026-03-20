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

function initDb(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;

  const client = new PrismaClient();

  // Cache in development to avoid exhausting database connections on hot reload
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
  }

  return client;
}

export const db = initDb();

export type { PrismaClient } from "@prisma/client";
export {
  Prisma,
  type User,
  type ConnectedService,
  type AuditLog,
} from "@prisma/client";
