import type { Prisma } from "@onecli/db";

/**
 * The private-thread fence (step 6's per-user amendment to §3.18): a
 * conversation with an OWNER (`userId`) is that user's private thread with
 * the agent, visible ONLY to them — their direct thread, and (since DM
 * threads) a thread opened inside their DM, which is sourced yet theirs.
 * Everything with no owner (group/channel threads, automations) stays
 * visible to the whole workspace. Expressed as a `where` fragment so every
 * reader composes it into its one fenced query, and a foreign thread reads
 * NOT_FOUND rather than "forbidden" (existence is never confirmed).
 *
 * Keyed on the OWNER, never on `direct`: `direct` says which conversation
 * the web chat is (one per user), and a DM thread is private without being
 * it. A fence on `direct: false` would read every DM thread as public.
 *
 * Every public read/write path takes the viewer EXPLICITLY, as a required
 * parameter — so a new call site cannot compile without deciding who is
 * looking. A module of its own (not conversation-service's) so the readers
 * elsewhere (turns, runs, the desktop) compose the SAME rule, and a test
 * that mocks conversation-service wholesale cannot swallow it.
 */
export const visibleTo = (
  viewerUserId: string,
): Prisma.ConversationWhereInput => ({
  OR: [{ userId: null }, { userId: viewerUserId }],
});
