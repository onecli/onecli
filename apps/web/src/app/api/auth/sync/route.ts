import { type NextRequest, NextResponse } from "next/server";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { verifyAndResolveIdentity } from "@/lib/validate-jwt";
import { logger } from "@/lib/logger";
import { DEFAULT_AGENT_NAME } from "@/lib/constants";
import { generateApiKey } from "@/lib/services/api-key-service";
import { generateAccessToken } from "@/lib/services/agent-service";
import { getSessionAttributes, onUserCreated } from "@/lib/auth/session-hooks";

/**
 * GET /api/auth/sync
 *
 * Single endpoint that handles the full auth → DB sync flow:
 * 1. Reads the auth session (cookie/token) or validates a JWT Bearer token
 * 2. Upserts the user in the database
 * 3. Ensures the user has an Account + AccountMember + ApiKey
 * 4. Seeds the default agent into the account
 * 5. Returns the user profile
 *
 * Called by the login page after auth, by the dashboard layout on mount,
 * or by API clients with a JWT access token to provision their account.
 * Returns 401 if no valid session or token exists.
 */
export const GET = async (request: NextRequest) => {
  try {
    // Try session auth first, then JWT Bearer token
    const session = await getServerSession();

    let authId: string;
    let email: string;
    let name: string | null | undefined;

    if (session?.email) {
      authId = session.id;
      email = session.email;
      name = session.name;
    } else {
      const identity = await verifyAndResolveIdentity(request);
      if (!identity) {
        return NextResponse.json(
          { error: "Not authenticated" },
          { status: 401 },
        );
      }
      authId = identity.sub;
      email = identity.email;
      name = identity.name;
    }

    const extra = getSessionAttributes(request);

    // Upsert user by email — creates on first login, updates on subsequent.
    const user = await db.user.upsert({
      where: { email },
      create: {
        externalAuthId: authId,
        email,
        name: name ?? null,
        lastLoginAt: new Date(),
        ...extra,
      },
      update: {
        externalAuthId: authId,
        name: name ?? null,
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
      select: { accountId: true },
    });

    if (!membership) {
      const account = await db.account.create({
        data: {
          name: user.name,
          createdByUserId: user.id,
          createdByUserEmail: user.email,
        },
        select: { id: true },
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

      membership = { accountId: account.id };

      onUserCreated({ email: user.email, name: user.name }, extra);
    }

    const accountId = membership.accountId;

    // Seed defaults into the account — idempotent, skips anything that already exists
    const hasDefaultAgent = await db.agent.findFirst({
      where: { accountId, isDefault: true },
      select: { id: true },
    });

    if (!hasDefaultAgent) {
      await db.agent.create({
        data: {
          name: DEFAULT_AGENT_NAME,
          accessToken: generateAccessToken(),
          isDefault: true,
          accountId,
        },
      });
    }

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
    });
  } catch (err) {
    logger.error({ err, route: "GET /api/auth/sync" }, "session sync failed");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
};
