import { db } from "@onecli/db";

/**
 * Delete a now-defunct placeholder user and the per-user rows that are NEVER
 * transferred to another user, inside an existing transaction. Single source of
 * truth for the placeholder-user teardown, used by the provision flows so the
 * cleanup can't drift (mirrors `deleteWorkspaceContent` /
 * `deleteOrganizationContent`).
 *
 * Precondition: the caller has already repointed OR deleted the placeholder's
 * TRANSFERABLE per-user `RESTRICT` children first — `organizationMember`,
 * `apiKey`, `userProvision` (and the `SET NULL` `workspace.createdByUserId`).
 * This helper handles only the rows that always die with the user
 * (`onboarding_surveys`, `audit_logs`), so it must NOT touch the transferable
 * ones — the claim flow hands those to the real user.
 */
export const deletePlaceholderUser = async (
  userId: string,
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
) => {
  await tx.onboardingSurvey.deleteMany({ where: { userId } });
  await tx.auditLog.deleteMany({ where: { userId } });
  await tx.user.delete({ where: { id: userId } });
};
