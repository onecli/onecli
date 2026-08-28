import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import {
  CONVERSATION_SOURCES,
  type ConversationSource,
} from "../validations/conversation";

/**
 * Conversations: one continuous exchange with a hosted agent (step 4; per-user
 * direct threads since step 6).
 *
 * Fencing follows the house rule — `workspaceId` first, expressed in the
 * `where` rather than checked after the fetch, so a conversation belonging to
 * another workspace reads as NOT_FOUND and never confirms its existence.
 */

const conversationSelect = {
  id: true,
  agentId: true,
  source: true,
  externalRef: true,
  direct: true,
  userId: true,
  title: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CreateConversationInput {
  agentId: string;
  source?: ConversationSource;
  externalRef?: string;
  title?: string;
}

/**
 * The direct-thread privacy fence (step 6's per-user amendment to §3.18): a
 * direct conversation is one user's private thread with the agent, visible
 * ONLY to its owner — group/source conversations stay visible to the whole
 * workspace. Expressed as a `where` fragment so every reader composes it into
 * its one fenced query, and a foreign thread reads NOT_FOUND rather than
 * "forbidden" (existence is never confirmed).
 *
 * Every public read/write path takes the viewer EXPLICITLY, as a required
 * parameter — so a new call site cannot compile without deciding who is
 * looking.
 */
const visibleTo = (viewerUserId: string): Prisma.ConversationWhereInput => ({
  OR: [{ direct: false }, { userId: viewerUserId }],
});

/**
 * The PLATFORM's door (step 7): load a conversation for a caller that is not
 * a person — a cron fire writing into its own run-conversation. Two
 * deliberate differences from `requireConversation`: there is no viewer (the
 * platform is not "looking", it is executing), and direct threads are
 * REFUSED outright — a system write into someone's private thread must go
 * through a purpose-built path (the delivery materializer), never through
 * the generic one, so a bug can't quietly speak as the platform in a DM.
 */
export const requireSystemConversation = async (
  workspaceId: string,
  conversationId: string,
) => {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, agent: { workspaceId }, direct: false },
    select: { ...conversationSelect, harnessSessionRef: true, lastSeq: true },
  });
  if (!conversation) {
    throw new ServiceError("NOT_FOUND", "Conversation not found");
  }
  return conversation;
};

/**
 * The purpose-built path the doctrine above demands: a PLATFORM wake turn
 * running INSIDE the direct thread the watched work belongs to, so the
 * report is the turn itself instead of a materialized copy from a hidden
 * conversation. Deliberately the mirror image of `requireSystemConversation`:
 * this door admits ONLY direct threads, only for the named agent — and it is
 * reachable solely through `TurnOrigin.directWake`, which every route stamps
 * server-side and none exposes. The creator/owner fence (who may be woken
 * into this thread) lives at the fire site, which holds both rows.
 */
export const requireDirectWakeConversation = async (
  workspaceId: string,
  conversationId: string,
  agentId: string,
) => {
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      agentId,
      agent: { workspaceId },
      direct: true,
    },
    select: { ...conversationSelect, harnessSessionRef: true, lastSeq: true },
  });
  if (!conversation) {
    throw new ServiceError("NOT_FOUND", "Conversation not found");
  }
  return conversation;
};

/**
 * Load a conversation the caller is allowed to see. The fence walks the
 * relation (`agent.workspaceId`) plus the direct-thread owner check, so it is
 * one query, not a fetch-then-check.
 */
export const requireConversation = async (
  workspaceId: string,
  conversationId: string,
  viewerUserId: string,
) => {
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      agent: { workspaceId },
      ...visibleTo(viewerUserId),
    },
    select: { ...conversationSelect, harnessSessionRef: true, lastSeq: true },
  });
  if (!conversation) {
    throw new ServiceError("NOT_FOUND", "Conversation not found");
  }
  return conversation;
};

/**
 * The fence both conversation doors share: the agent must exist in this
 * workspace (expressed in the `where`, so a foreign agent reads NOT_FOUND) and
 * must be hosted — only hosted agents have a computer to hold a conversation.
 */
const requireHostedAgent = async (workspaceId: string, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, kind: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  if (agent.kind !== "hosted") {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Only hosted agents can hold conversations",
    );
  }
  return agent;
};

export const createConversation = async (
  workspaceId: string,
  input: CreateConversationInput,
) => {
  const agent = await requireHostedAgent(workspaceId, input.agentId);

  const source = input.source ?? "web";
  if (!CONVERSATION_SOURCES.includes(source)) {
    throw new ServiceError("BAD_REQUEST", "Unknown conversation source");
  }

  return db.conversation.create({
    data: {
      agentId: agent.id,
      source,
      externalRef: input.externalRef ?? null,
      title: input.title?.trim() || null,
    },
    select: conversationSelect,
  });
};

/**
 * A user's direct thread with an agent, if it has been materialized. The fence
 * rides the relation filter, so this is ONE query and a foreign or non-hosted
 * agent simply matches nothing — existence is never confirmed.
 */
const findDirectConversation = (
  workspaceId: string,
  agentId: string,
  userId: string,
) =>
  db.conversation.findFirst({
    where: {
      direct: true,
      userId,
      agent: { id: agentId, workspaceId, kind: "hosted" },
    },
    select: conversationSelect,
  });

/**
 * The direct thread's only door (§3.18, per-user since step 6): get-or-create
 * THIS USER's one canonical conversation with the agent. Idempotent — every
 * surface a user reaches the agent through lands on the same row, which is
 * the point: their web thread and their Slack DM call this with the same
 * (agent, user) and read/write identical history. Another user gets another
 * row. Two concurrent calls race on `conversations_one_direct_per_agent_user`;
 * the loser re-reads the winner's row.
 *
 * The hot path — every visit after the first — is a single query. The
 * explicit refusals only cost a second one when there is nothing to return,
 * which is also the only path that needs to tell "not yours" from "not
 * hosted".
 *
 * Deliberately unreachable through POST /v1/conversations — `direct` is not in
 * its schema — so an ordinary create can never mint a direct thread. Direct
 * threads carry no title: the agent is the name (§3.18).
 */
export const ensureDirectConversation = async (
  workspaceId: string,
  agentId: string,
  userId: string,
  source: ConversationSource = "web",
) => {
  const existing = await findDirectConversation(workspaceId, agentId, userId);
  if (existing) return existing;

  const agent = await requireHostedAgent(workspaceId, agentId);

  try {
    return await db.conversation.create({
      // `source` records the door that happened to mint the row; on a DIRECT
      // conversation it says nothing about who is talking, because the whole
      // point is that this user's surfaces share it (§3.16: their Slack DM is
      // this same row). Read `direct` + `userId`, never `source`, to reason
      // about it.
      data: { agentId: agent.id, direct: true, source, userId },
      select: conversationSelect,
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const winner = await findDirectConversation(
        workspaceId,
        agent.id,
        userId,
      );
      if (winner) return winner;
    }
    throw err;
  }
};

/**
 * Get-or-create the conversation bound to an external source thread — the
 * group sibling of `ensureDirectConversation`, used by the channel ingestion
 * doors (step 6). Race-safe against `conversations(agent_id, source,
 * external_ref)`: find-then-create would mint two conversations — and two
 * harness sessions — for two concurrent events on one provider thread, which
 * is exactly the context bleed `source`/`externalRef` exist to prevent
 * (recorded as owed by step 6 in the step-4 plan).
 */
export const ensureSourcedConversation = async (
  workspaceId: string,
  agentId: string,
  input: { source: ConversationSource; externalRef: string; title?: string },
) => {
  const find = () =>
    db.conversation.findFirst({
      where: {
        agentId,
        source: input.source,
        externalRef: input.externalRef,
        agent: { workspaceId, kind: "hosted" },
      },
      select: conversationSelect,
    });

  const existing = await find();
  if (existing) return existing;

  const agent = await requireHostedAgent(workspaceId, agentId);

  try {
    return await db.conversation.create({
      data: {
        agentId: agent.id,
        source: input.source,
        externalRef: input.externalRef,
        title: input.title?.trim() || null,
      },
      select: conversationSelect,
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const winner = await find();
      if (winner) return winner;
    }
    throw err;
  }
};

export const listConversations = async (
  workspaceId: string,
  viewerUserId: string,
  agentId?: string,
) =>
  db.conversation.findMany({
    where: {
      agent: { workspaceId },
      ...(agentId && { agentId }),
      ...visibleTo(viewerUserId),
    },
    select: conversationSelect,
    orderBy: { createdAt: "desc" },
    take: 100,
  });

/**
 * The public view. Deliberately narrower than `requireConversation`, which
 * also loads the harness session ref and the seq counter — internals no API
 * response should carry.
 */
export const getConversation = async (
  workspaceId: string,
  conversationId: string,
  viewerUserId: string,
) => {
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      agent: { workspaceId },
      ...visibleTo(viewerUserId),
    },
    select: conversationSelect,
  });
  if (!conversation) {
    throw new ServiceError("NOT_FOUND", "Conversation not found");
  }
  return conversation;
};
