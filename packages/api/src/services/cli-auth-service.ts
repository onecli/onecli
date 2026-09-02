import { randomBytes } from "crypto";
import { db } from "@onecli/db";
import { ServiceError } from "./errors";

const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Create a pending CLI auth session.
 * The caller receives a code and auth URL to show the user.
 */
export const createCliAuthSession = async (appUrl: string) => {
  // Lazy cleanup of old sessions (fire-and-forget, don't block the response)
  void db.cliAuthSession
    .deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - CLEANUP_AGE_MS) } },
    })
    .catch(() => {});

  const code = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.cliAuthSession.create({
    data: { code, expiresAt },
  });

  return {
    code,
    auth_url: `${appUrl}/auth/cli?code=${code}`,
  };
};

/**
 * Poll a CLI auth session by code.
 * Returns the current status and API key if confirmed.
 */
export const pollCliAuthSession = async (code: string) => {
  const session = await db.cliAuthSession.findUnique({
    where: { code },
    select: { status: true, apiKey: true, expiresAt: true },
  });

  if (!session) {
    throw new ServiceError("NOT_FOUND", "Session not found");
  }

  if (session.status === "pending" && session.expiresAt < new Date()) {
    await db.cliAuthSession.update({
      where: { code },
      data: { status: "expired" },
    });
    return { status: "expired" as const };
  }

  if (session.status === "confirmed" && session.apiKey) {
    const apiKeyRecord = await db.apiKey.findUnique({
      where: { key: session.apiKey },
      select: { workspaceId: true },
    });

    // Clear the API key after reading so it can only be consumed once
    await db.cliAuthSession.update({
      where: { code },
      data: { apiKey: null, status: "consumed" },
    });
    return {
      status: "ok" as const,
      api_key: session.apiKey,
      workspace_id: apiKeyRecord?.workspaceId ?? null,
    };
  }

  if (session.status === "expired") {
    return { status: "expired" as const };
  }

  return { status: "pending" as const };
};

/**
 * Confirm a CLI auth session with the authenticated user's API key.
 * Uses an atomic update (where status = "pending") to prevent races.
 */
export const confirmCliAuthSession = async (code: string, apiKey: string) => {
  const session = await db.cliAuthSession.findUnique({
    where: { code },
    select: { status: true, expiresAt: true },
  });

  if (!session) {
    throw new ServiceError("NOT_FOUND", "Session not found");
  }

  if (session.expiresAt < new Date()) {
    await db.cliAuthSession.update({
      where: { code },
      data: { status: "expired" },
    });
    throw new ServiceError("BAD_REQUEST", "Session expired");
  }

  if (session.status !== "pending") {
    throw new ServiceError("CONFLICT", "Session already confirmed");
  }

  await db.cliAuthSession.update({
    where: { code, status: "pending", expiresAt: { gte: new Date() } },
    data: { status: "confirmed", apiKey },
  });
};
