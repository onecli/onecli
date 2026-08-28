"use server";

import { z } from "zod";
import { db, type Prisma } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { notifyDiscord } from "@onecli/api/ee/notifications/discord";
import { findUserDefaultWorkspace } from "@onecli/api/services/organization-service";
import { safeAction, type ActionResult } from "@/lib/safe-action";
import type { OnboardingProgress } from "./steps";

const resolveOnboardingContext = async () => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");
  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true, email: true },
  });
  if (!user) throw new Error("User not found");
  const workspace = await findUserDefaultWorkspace(user.id);
  if (!workspace) throw new Error("No workspace found");
  return {
    userId: user.id,
    userEmail: user.email,
    workspaceId: workspace.id,
  };
};

/** The only survey keys a client may write, with sane size caps — a server
 * action is a POST endpoint any authenticated session can invoke, so the
 * merge below must never accept arbitrary unbounded JSON. */
const progressSchema = z.strictObject({
  discovery: z.array(z.string().max(100)).max(20).optional(),
  createdAgentId: z.string().max(100).nullish(),
  agentName: z.string().max(255).nullish(),
});

type ProgressInput = z.infer<typeof progressSchema>;

/** safeAction surfaces thrown messages to the user — a refused save must read
 * as a sentence, never a serialized ZodError. */
const parseProgress = (input: unknown): ProgressInput => {
  const parsed = progressSchema.safeParse(input);
  if (!parsed.success)
    throw new Error("Couldn't save your progress. Please try again.");
  return parsed.data;
};

/** Merge, never overwrite: v2 saves are partial (created agent, survey
 * answers arrive at different moments), and a progress save must not erase
 * what an earlier one recorded — a null/absent field means "leave as
 * recorded", never "clear" (the skip path completes with nulls, and those
 * must not wipe an agent an earlier save captured). */
const mergeSurveyResponses = async (
  ctx: { userId: string; userEmail: string; workspaceId: string },
  responses: ProgressInput,
) => {
  const updates = Object.fromEntries(
    Object.entries(responses).filter(([, v]) => v != null),
  );
  const existing = await db.onboardingSurvey.findUnique({
    where: { workspaceId: ctx.workspaceId },
    select: { responses: true },
  });
  const prior =
    existing?.responses &&
    typeof existing.responses === "object" &&
    !Array.isArray(existing.responses)
      ? (existing.responses as Record<string, unknown>)
      : {};
  const merged = { ...prior, ...updates };
  const discoveryArr = Array.isArray(merged.discovery)
    ? (merged.discovery as string[])
    : [];

  await db.onboardingSurvey.upsert({
    where: { workspaceId: ctx.workspaceId },
    create: {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      responses: merged as Prisma.InputJsonValue,
      discovery: discoveryArr,
    },
    update: {
      responses: merged as Prisma.InputJsonValue,
      discovery: discoveryArr,
    },
  });
};

/** Persist in-progress answers without completing onboarding (no completion
 * timestamp, no notification). Used at step transitions so refresh/resume can
 * rehydrate the flow. */
export async function saveOnboardingProgress(
  responses: ProgressInput,
): Promise<ActionResult> {
  return safeAction(async () => {
    const parsed = parseProgress(responses);
    const ctx = await resolveOnboardingContext();
    await mergeSurveyResponses(ctx, parsed);
  });
}

/** Mark onboarding done. Idempotent — a second call (skip after create,
 * refresh on the team step) neither re-stamps nor re-notifies. */
export async function completeOnboarding(data: {
  createdAgentId: string | null;
  agentName: string | null;
}): Promise<ActionResult> {
  return safeAction(async () => {
    const parsed = parseProgress(data);
    const ctx = await resolveOnboardingContext();
    const { userId, userEmail } = ctx;

    await mergeSurveyResponses(ctx, parsed);

    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { onboardingCompletedAt: true },
    });
    if (user.onboardingCompletedAt !== null) return;

    await db.user.update({
      where: { id: userId },
      data: { onboardingCompletedAt: new Date() },
    });

    notifyDiscord("onboarding_completed", {
      email: userEmail,
      agentName: parsed.agentName,
    });
  });
}

const emptyProgress = (): OnboardingProgress => ({
  discovery: [],
  agentName: null,
  createdAgentId: null,
});

/** Saved progress used to seed the client flow. Never throws: during first
 * login the default org/workspace may not exist yet (it's lazily created by
 * `getActiveWorkspacePath` in the same layout boot batch), and "no workspace"
 * simply means "no progress". */
export async function getOnboardingProgress(): Promise<OnboardingProgress> {
  try {
    const session = await getServerSession();
    if (!session) return emptyProgress();

    const { workspaceId } = await resolveOnboardingContext();

    const survey = await db.onboardingSurvey.findUnique({
      where: { workspaceId },
      select: { responses: true },
    });
    if (!survey) return emptyProgress();

    const responses =
      survey.responses &&
      typeof survey.responses === "object" &&
      !Array.isArray(survey.responses)
        ? (survey.responses as Record<string, unknown>)
        : {};

    return {
      discovery: Array.isArray(responses.discovery)
        ? responses.discovery.filter((d): d is string => typeof d === "string")
        : [],
      agentName:
        typeof responses.agentName === "string" ? responses.agentName : null,
      createdAgentId:
        typeof responses.createdAgentId === "string"
          ? responses.createdAgentId
          : null,
    };
  } catch {
    return emptyProgress();
  }
}

export async function checkOnboardingComplete(): Promise<boolean> {
  const session = await getServerSession();
  if (!session) return false;

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { onboardingCompletedAt: true },
  });

  return user?.onboardingCompletedAt !== null;
}
