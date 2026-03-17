import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { db, Prisma } from "@onecli/db";
import { validateApiKey } from "@/lib/validate-api-key";
import { getServerSession } from "@/lib/auth/server";

const IDENTIFIER_REGEX = /^[a-z][a-z0-9-]{0,49}$/;

const generateAccessToken = () => `aoc_${randomBytes(32).toString("hex")}`;

/**
 * POST /api/agents
 *
 * Create a new agent programmatically.
 * Auth: `Authorization: Bearer oc_...` (user API key) or JWT session.
 */
export async function POST(request: NextRequest) {
  try {
    const apiKeyUser = await validateApiKey(request);

    let userId: string | null = null;

    if (apiKeyUser) {
      userId = apiKeyUser.id;
    } else {
      const session = await getServerSession();
      if (session) {
        const user = await db.user.findUnique({
          where: { externalAuthId: session.id },
          select: { id: true },
        });
        userId = user?.id ?? null;
      }
    }

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (
      !body ||
      typeof body.name !== "string" ||
      typeof body.identifier !== "string"
    ) {
      return NextResponse.json(
        {
          error:
            "Request body must include 'name' (string) and 'identifier' (string)",
        },
        { status: 400 },
      );
    }

    const name = body.name.trim();
    if (!name || name.length > 255) {
      return NextResponse.json(
        { error: "Name must be between 1 and 255 characters" },
        { status: 400 },
      );
    }

    const identifier = body.identifier.trim();
    if (!IDENTIFIER_REGEX.test(identifier)) {
      return NextResponse.json(
        {
          error:
            "Identifier must be 1-50 characters, start with a letter, and contain only lowercase letters, numbers, and hyphens",
        },
        { status: 400 },
      );
    }

    const existing = await db.agent.findFirst({
      where: { userId, identifier },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: "An agent with this identifier already exists" },
        { status: 400 },
      );
    }

    const accessToken = generateAccessToken();

    const agent = await db.agent.create({
      data: {
        name,
        identifier,
        accessToken,
        secretMode: "selective",
        userId,
      },
      select: {
        id: true,
        name: true,
        identifier: true,
        accessToken: true,
      },
    });

    // Auto-assign the first anthropic secret if one exists
    const anthropicSecret = await db.secret.findFirst({
      where: { userId, type: "anthropic" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });

    if (anthropicSecret) {
      await db.agentSecret.create({
        data: { agentId: agent.id, secretId: anthropicSecret.id },
      });
    }

    return NextResponse.json(agent, { status: 201 });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "An agent with this identifier already exists" },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
