import { NextResponse } from "next/server";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { cryptoService } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import {
  DEFAULT_AGENT_NAME,
  DEMO_SECRET_NAME,
  DEMO_SECRET_VALUE,
} from "@/lib/constants";
import { generateApiKey } from "@/lib/services/api-key-service";
import { generateAccessToken } from "@/lib/services/agent-service";

/**
 * GET /api/auth/session
 *
 * Single endpoint that handles the full auth → DB sync flow:
 * 1. Reads the auth session (cookie/token)
 * 2. Upserts the user in the database
 * 3. Seeds defaults (agent, demo secret, API key)
 * 4. Returns the user profile
 *
 * Called by the login page after auth and by the dashboard layout on mount.
 * Returns 401 if no valid session exists.
 */
export const GET = async () => {
  try {
    const session = await getServerSession();
    if (!session || !session.email) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Upsert user by email — creates on first login, updates on subsequent.
    // Also updates externalAuthId in case the user re-registered with a
    // different auth provider (e.g., switched from Google to email OTP).
    const user = await db.user.upsert({
      where: { email: session.email },
      create: {
        externalAuthId: session.id,
        email: session.email,
        name: session.name,
        apiKey: generateApiKey(),
      },
      update: {
        externalAuthId: session.id,
        name: session.name,
      },
      select: {
        id: true,
        email: true,
        name: true,
        apiKey: true,
        demoSeeded: true,
      },
    });

    // Ensure API key exists (backfill for users created before this field)
    if (!user.apiKey) {
      await db.user.update({
        where: { id: user.id },
        data: { apiKey: generateApiKey() },
      });
    }

    // Seed defaults — idempotent, skips anything that already exists
    const ops = [];

    const hasDefaultAgent = await db.agent.findFirst({
      where: { userId: user.id, isDefault: true },
      select: { id: true },
    });

    if (!hasDefaultAgent) {
      ops.push(
        db.agent.create({
          data: {
            name: DEFAULT_AGENT_NAME,
            accessToken: generateAccessToken(),
            isDefault: true,
            userId: user.id,
          },
        }),
      );
    }

    if (!user.demoSeeded) {
      ops.push(
        db.secret.create({
          data: {
            name: DEMO_SECRET_NAME,
            type: "generic",
            encryptedValue: await cryptoService.encrypt(DEMO_SECRET_VALUE),
            hostPattern: "httpbin.org",
            pathPattern: "/anything/*",
            injectionConfig: {
              headerName: "Authorization",
              valueFormat: "Bearer {value}",
            },
            userId: user.id,
          },
        }),
        db.user.update({
          where: { id: user.id },
          data: { demoSeeded: true },
        }),
      );
    }

    if (ops.length > 0) {
      await db.$transaction(ops);
    }

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
    });
  } catch (err) {
    logger.error(
      { err, route: "GET /api/auth/session" },
      "session sync failed",
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
};
