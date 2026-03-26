import { type NextRequest, NextResponse } from "next/server";
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
import { getSessionAttributes, onUserCreated } from "@/lib/auth/session-hooks";

/**
 * GET /api/auth/session
 *
 * Single endpoint that handles the full auth → DB sync flow:
 * 1. Reads the auth session (cookie/token)
 * 2. Upserts the user in the database
 * 3. Ensures the user has an Account + AccountMember + ApiKey
 * 4. Seeds defaults (agent, demo secret) into the account
 * 5. Returns the user profile
 *
 * Called by the login page after auth and by the dashboard layout on mount.
 * Returns 401 if no valid session exists.
 */
export const GET = async (request: NextRequest) => {
  try {
    const session = await getServerSession();
    if (!session || !session.email) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const extra = getSessionAttributes(request);

    // Upsert user by email — creates on first login, updates on subsequent.
    const user = await db.user.upsert({
      where: { email: session.email },
      create: {
        externalAuthId: session.id,
        email: session.email,
        name: session.name,
        lastLoginAt: new Date(),
        ...extra,
      },
      update: {
        externalAuthId: session.id,
        name: session.name,
        lastLoginAt: new Date(),
        ...extra,
      },
      select: {
        id: true,
        email: true,
        name: true,
      },
    });

    // Ensure the user has an Account. Create one if this is their first login.
    let membership = await db.accountMember.findFirst({
      where: { userId: user.id },
      select: {
        accountId: true,
        account: { select: { demoSeeded: true } },
      },
    });

    if (!membership) {
      const account = await db.account.create({
        data: {
          name: user.name,
          createdByUserId: user.id,
          createdByUserEmail: user.email,
        },
        select: { id: true, demoSeeded: true },
      });

      await db.accountMember.create({
        data: {
          accountId: account.id,
          userId: user.id,
          userEmail: user.email,
          role: "owner",
        },
      });

      // Create API key for this user in the new account
      await db.apiKey.create({
        data: {
          key: generateApiKey(),
          userId: user.id,
          userEmail: user.email,
          accountId: account.id,
        },
      });

      membership = {
        accountId: account.id,
        account: { demoSeeded: account.demoSeeded },
      };

      onUserCreated({ email: user.email, name: user.name });
    }

    const accountId = membership.accountId;
    const demoSeeded = membership.account.demoSeeded;

    // Seed defaults into the account — idempotent, skips anything that already exists
    const ops = [];

    const hasDefaultAgent = await db.agent.findFirst({
      where: { accountId, isDefault: true },
      select: { id: true },
    });

    if (!hasDefaultAgent) {
      ops.push(
        db.agent.create({
          data: {
            name: DEFAULT_AGENT_NAME,
            accessToken: generateAccessToken(),
            isDefault: true,
            accountId,
          },
        }),
      );
    }

    if (!demoSeeded) {
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
            accountId,
          },
        }),
        db.account.update({
          where: { id: accountId },
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
