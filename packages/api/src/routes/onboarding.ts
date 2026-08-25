import { Hono } from "hono";
import { db, type Prisma } from "@onecli/db";
import { markOnboardingCompleteByApiKey } from "../services/onboarding-service";

const API_KEY_PATTERN = /^oc_[a-f0-9]{64}$/;

export const onboardingRoutes = () => {
  const app = new Hono();

  // POST /install-complete
  app.post("/install-complete", async (c) => {
    const apiKeyHeader = c.req.header("X-API-Key");

    if (!apiKeyHeader || !API_KEY_PATTERN.test(apiKeyHeader)) {
      return c.json({ error: "Missing or invalid API key" }, 401);
    }

    const apiKey = await db.apiKey.findUnique({
      where: { key: apiKeyHeader },
      select: { workspaceId: true, userId: true, userEmail: true },
    });

    if (!apiKey || !apiKey.workspaceId) {
      return c.json({ error: "API key not found" }, 401);
    }

    let body: { type?: string } = {};
    try {
      body = (await c.req.json()) as { type?: string };
    } catch {
      // body is optional
    }

    // The web flow no longer reads setupState (v2 onboarding dropped the
    // install/test-run steps) — the bookkeeping below is kept deliberately:
    // shipped install scripts in the wild POST here, and installType /
    // installedAt / connectedAt remain operator-queryable install telemetry.
    const rawType = body.type;
    const installType =
      rawType === "migrate"
        ? "migrate"
        : rawType === "cli-install"
          ? "cli-install"
          : "install";
    const now = new Date().toISOString();

    const existing = await db.onboardingSurvey.findUnique({
      where: { workspaceId: apiKey.workspaceId },
      select: { setupState: true },
    });

    const existingState =
      existing?.setupState && typeof existing.setupState === "object"
        ? (existing.setupState as Record<string, unknown>)
        : {};

    const isCli = installType === "cli-install";
    const setupState: Prisma.InputJsonValue = {
      ...existingState,
      installType,
      installedAt: now,
      ...(isCli ? { connectedAt: now } : {}),
    };

    await db.onboardingSurvey.upsert({
      where: { workspaceId: apiKey.workspaceId },
      create: {
        workspaceId: apiKey.workspaceId,
        userId: apiKey.userId,
        userEmail: apiKey.userEmail,
        setupState,
      },
      update: {
        setupState,
      },
    });

    // Backstop: the script-serving routes already mark onboarding complete on
    // fetch, but mark again here in case that write was missed.
    await markOnboardingCompleteByApiKey(apiKeyHeader).catch(() => {});

    return c.json({ ok: true });
  });

  return app;
};
