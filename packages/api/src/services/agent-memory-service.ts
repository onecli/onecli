import { db, Prisma } from "@onecli/db";
import {
  MEMORY_FILE_CONTENT_MAX_CHARS,
  flattenToLine,
  memoryFileFitsFrame,
} from "@onecli/agent-protocol";
import { ServiceError } from "./errors";
import { bumpHomeForAgent } from "./home-sync-service";
import type { MemoryAuthorKind, MemoryOp } from "../validations/memories";

/**
 * Agent memory (plans/hosted-agents-v2.md step 8, §3.8).
 *
 * Truth lives here, never in the sandbox: the two doors write through this
 * service — the dashboard routes (user authority, workspace-fenced) and the
 * memory_* platform tools (agent authority, fenced by the runner's two-fact
 * identity). The HEAD ROW is the current state, materialized; every write
 * appends a full snapshot to agent_memory_revisions inside one transaction,
 * with `lastRevisionSeq` as the allocator (the Conversation.lastSeq pattern:
 * the row lock serializes concurrent saves, so seq order is commit order).
 *
 * Agent-level only by decision (2026-08-07) — workspace-shared memory is a
 * recorded maybe-later (plans/v2-todo.md) and everything here stays additive
 * for it.
 */

/**
 * Memories one agent may hold. An availability bound, not a product limit
 * (the MAX_CRONS_PER_AGENT reasoning): memory_save is agent-callable, and
 * the always-injected turn-start index plus the index-free search scan are
 * both sized by this cap.
 */
export const MAX_MEMORIES_PER_AGENT = 100;

/**
 * Revisions kept per memory — the newest N. Pruned inside the save
 * transaction; `lastRevisionSeq` keeps counting, so seq stays monotonic and
 * the history list is a bounded read with no pagination.
 */
export const MEMORY_REVISIONS_RETAINED = 50;

/** Default result bound for memory_search and the dashboard's ?q=. */
export const MEMORY_SEARCH_LIMIT = 8;

/** What redaction leaves in a scrubbed snapshot's content. */
export const REDACTED_CONTENT = "[redacted]";

/** Revision-list previews: the history sheet shows this much per revision
 * and fetches one full revision on selection — at the 100k file cap a full
 * 50-revision list would be a ~5MB response. */
export const MEMORY_REVISION_PREVIEW_CHARS = 2_000;

const memoryIndexSelect = {
  id: true,
  agentId: true,
  key: true,
  title: true,
  description: true,
  lastRevisionSeq: true,
  createdAt: true,
  updatedAt: true,
} as const;

const memoryDetailSelect = { ...memoryIndexSelect, content: true } as const;

/** The list/index projection — deliberately body-free (the index is the map;
 * bodies are fetched per memory). */
export type AgentMemoryIndexView = {
  id: string;
  agentId: string;
  key: string;
  title: string | null;
  description: string | null;
  lastRevisionSeq: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentMemoryView = AgentMemoryIndexView & { content: string };

const revisionSelect = {
  id: true,
  seq: true,
  op: true,
  restoredFromSeq: true,
  title: true,
  description: true,
  content: true,
  authorKind: true,
  authorUserId: true,
  authorEmail: true,
  conversationId: true,
  turnId: true,
  redactedAt: true,
  redactedByUserId: true,
  createdAt: true,
} as const;

export type MemoryRevisionView = {
  id: string;
  seq: number;
  op: string;
  restoredFromSeq: number | null;
  title: string | null;
  description: string | null;
  content: string;
  authorKind: string;
  authorUserId: string | null;
  authorEmail: string | null;
  conversationId: string | null;
  turnId: string | null;
  redactedAt: Date | null;
  redactedByUserId: string | null;
  createdAt: Date;
};

export type MemorySearchHit = {
  id: string;
  key: string;
  title: string | null;
  description: string | null;
  snippet: string;
  rank: number;
  updatedAt: Date;
};

/**
 * Who is writing, resolved by the door: the dashboard routes pass the session
 * user; the tool door passes the resolved via-user from the calling turn
 * (null during scheduled runs — recorded honestly, and the audit layer skips
 * an attribution-less write on its own).
 */
export interface MemoryAuthor {
  authorKind: MemoryAuthorKind;
  authorUserId: string | null;
  /** Denormalized at write time (the AuditLog convention) so attribution
   * survives user deletion. */
  authorEmail: string | null;
  conversationId: string | null;
  turnId: string | null;
}

export interface MemoryInput {
  key: string;
  content: string;
  title?: string;
  description?: string;
}

export interface MemoryPatch {
  title?: string | null;
  description?: string | null;
  content?: string;
}

/** The agent fence both doors share — workspace-scoped, hosted-only (the
 * agent-cron-service pattern verbatim). */
const requireHostedAgent = async (workspaceId: string, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, kind: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  if (agent.kind !== "hosted") {
    throw new ServiceError("UNPROCESSABLE", "Only hosted agents have memory");
  }
  return agent;
};

type Tx = Prisma.TransactionClient;

interface MemoryState {
  title: string | null;
  description: string | null;
  content: string;
}

/**
 * The exact deliverability gate: a memory that cannot ride back DOWN into
 * the sandbox as a single bare sync frame must be refused at every door
 * that accepts the big content cap — otherwise it would save fine and then
 * be silently skipped by the part packer forever (the chars cap alone lets
 * maxed CJK content triple past the byte budget).
 */
const assertProjectable = (key: string, state: MemoryState): void => {
  if (!memoryFileFitsFrame({ key, ...state })) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This memory is too large to sync to the agent's machine: split it into smaller linked memories",
    );
  }
};

/**
 * The one write shape every mutation uses: bump the allocator on the head
 * (the row lock serializes writers), snapshot the NEW state as that seq's
 * revision, prune beyond retention. Callers run it inside a transaction and
 * have already applied the state to the head row.
 */
const appendRevision = async (
  tx: Tx,
  memoryId: string,
  seq: number,
  state: MemoryState,
  op: MemoryOp,
  restoredFromSeq: number | null,
  author: MemoryAuthor,
): Promise<void> => {
  await tx.agentMemoryRevision.create({
    data: {
      memoryId,
      seq,
      op,
      restoredFromSeq,
      title: state.title,
      description: state.description,
      content: state.content,
      authorKind: author.authorKind,
      authorUserId: author.authorUserId,
      authorEmail: author.authorEmail,
      conversationId: author.conversationId,
      turnId: author.turnId,
    },
  });
  await tx.agentMemoryRevision.deleteMany({
    where: { memoryId, seq: { lte: seq - MEMORY_REVISIONS_RETAINED } },
  });
};

export const listMemories = async (
  workspaceId: string,
  agentId: string,
): Promise<AgentMemoryIndexView[]> => {
  await requireHostedAgent(workspaceId, agentId);
  return db.agentMemory.findMany({
    where: { agentId },
    orderBy: { key: "asc" },
    select: memoryIndexSelect,
  });
};

export const getMemory = async (
  workspaceId: string,
  agentId: string,
  memoryId: string,
): Promise<AgentMemoryView & { latestRevision: MemoryRevisionView | null }> => {
  await requireHostedAgent(workspaceId, agentId);
  // Fenced read: existence is decided by the (id, agentId) pair, so a foreign
  // memory id reads as NOT_FOUND, never as a hint.
  const memory = await db.agentMemory.findFirst({
    where: { id: memoryId, agentId },
    select: {
      ...memoryDetailSelect,
      revisions: {
        orderBy: { seq: "desc" },
        take: 1,
        select: revisionSelect,
      },
    },
  });
  if (!memory) throw new ServiceError("NOT_FOUND", "Memory not found");
  const { revisions, ...head } = memory;
  return { ...head, latestRevision: revisions[0] ?? null };
};

/** The memory_get door. The instructive miss is deliberate — the model is the
 * caller, and "what exists" is exactly the feedback it needs. */
export const getMemoryByKey = async (
  workspaceId: string,
  agentId: string,
  key: string,
): Promise<AgentMemoryView> => {
  await requireHostedAgent(workspaceId, agentId);
  const memory = await db.agentMemory.findFirst({
    where: { agentId, key },
    select: memoryDetailSelect,
  });
  if (!memory) {
    throw new ServiceError(
      "NOT_FOUND",
      `No memory named "${key}". memory_list shows what exists.`,
    );
  }
  return memory;
};

const capMessage = `This agent already holds ${MAX_MEMORIES_PER_AGENT} memories. Update an existing key with memory_save, or delete one on the Memory page`;

export const createMemory = async (
  workspaceId: string,
  agentId: string,
  input: MemoryInput,
  author: MemoryAuthor,
): Promise<AgentMemoryView> => {
  await requireHostedAgent(workspaceId, agentId);
  const held = await db.agentMemory.count({ where: { agentId } });
  if (held >= MAX_MEMORIES_PER_AGENT) {
    throw new ServiceError("UNPROCESSABLE", capMessage);
  }
  const state: MemoryState = {
    title: input.title ?? null,
    description: input.description ?? null,
    content: input.content,
  };
  assertProjectable(input.key, state);
  try {
    const memory = await db.$transaction(async (tx) => {
      const created = await tx.agentMemory.create({
        data: { agentId, key: input.key, ...state, lastRevisionSeq: 1 },
        select: memoryDetailSelect,
      });
      await appendRevision(tx, created.id, 1, state, "save", null, author);
      return created;
    });
    await bumpHomeForAgent(agentId);
    return memory;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        `A memory named "${input.key}" already exists`,
      );
    }
    throw err;
  }
};

const applyState = async (
  memoryId: string,
  state: MemoryState,
  op: MemoryOp,
  restoredFromSeq: number | null,
  author: MemoryAuthor,
): Promise<AgentMemoryView> => {
  const head = await db.$transaction(async (tx) => {
    const updated = await tx.agentMemory.update({
      where: { id: memoryId },
      data: { ...state, lastRevisionSeq: { increment: 1 } },
      select: memoryDetailSelect,
    });
    await appendRevision(
      tx,
      memoryId,
      updated.lastRevisionSeq,
      state,
      op,
      restoredFromSeq,
      author,
    );
    return updated;
  });
  // Every head change re-materializes memory/<key>.md + index.md in a
  // RUNNING sandbox (step 9). Sitting here means update, tool upsert, and
  // restore all bump; no-op writes and redact (old revisions only — the head
  // is untouched by construction) never reach this function.
  await bumpHomeForAgent(head.agentId);
  return head;
};

const isNoOp = (current: MemoryState, next: MemoryState): boolean =>
  current.title === next.title &&
  current.description === next.description &&
  current.content === next.content;

export const updateMemory = async (
  workspaceId: string,
  agentId: string,
  memoryId: string,
  patch: MemoryPatch,
  author: MemoryAuthor,
): Promise<AgentMemoryView> => {
  await requireHostedAgent(workspaceId, agentId);
  const existing = await db.agentMemory.findFirst({
    where: { id: memoryId, agentId },
    select: memoryDetailSelect,
  });
  if (!existing) throw new ServiceError("NOT_FOUND", "Memory not found");

  const next: MemoryState = {
    title: patch.title === undefined ? existing.title : patch.title,
    description:
      patch.description === undefined
        ? existing.description
        : patch.description,
    content: patch.content === undefined ? existing.content : patch.content,
  };
  // A write that changes nothing appends nothing — history stays
  // human-meaningful, and an agent re-saving an unchanged fact is free.
  if (isNoOp(existing, next)) return existing;
  assertProjectable(existing.key, next);
  return applyState(memoryId, next, "save", null, author);
};

/**
 * The memory_save door: create-or-update by key. The race loser (two first
 * saves of the same key) lands as an update — the ensureSourcedConversation
 * loser rule: re-read the winner, never throw.
 */
export const upsertMemoryByKey = async (
  workspaceId: string,
  agentId: string,
  input: MemoryInput,
  author: MemoryAuthor,
): Promise<{ memory: AgentMemoryView; created: boolean; noop: boolean }> => {
  await requireHostedAgent(workspaceId, agentId);

  const overwrite = async (): Promise<{
    memory: AgentMemoryView;
    created: boolean;
    noop: boolean;
  } | null> => {
    const existing = await db.agentMemory.findFirst({
      where: { agentId, key: input.key },
      select: memoryDetailSelect,
    });
    if (!existing) return null;
    const next: MemoryState = {
      // MERGE semantics on the tool door: an omitted title/description is
      // PRESERVED, not cleared — agents routinely re-save content alone, and
      // that must never wipe a human's dashboard curation. (Clearing is a
      // dashboard edit: PATCH with an explicit null.)
      title: input.title !== undefined ? input.title : existing.title,
      description:
        input.description !== undefined
          ? input.description
          : existing.description,
      content: input.content,
    };
    // `noop` is load-bearing for the file harvester: it is the echo
    // terminator — "the platform already holds exactly this" tells the
    // supervisor to stop re-sending without minting a revision.
    if (isNoOp(existing, next)) {
      return { memory: existing, created: false, noop: true };
    }
    assertProjectable(input.key, next);
    const memory = await applyState(existing.id, next, "save", null, author);
    return { memory, created: false, noop: false };
  };

  const updated = await overwrite();
  if (updated) return updated;

  try {
    const memory = await createMemory(workspaceId, agentId, input, author);
    return { memory, created: true, noop: false };
  } catch (err) {
    if (err instanceof ServiceError && err.code === "CONFLICT") {
      const settled = await overwrite();
      if (settled) return settled;
    }
    throw err;
  }
};

/**
 * The FILE door (the projection's write-back half): the supervisor harvested
 * agent-authored bytes under `memory/` and is saving them. Same merge
 * semantics as the tool door — a file without frontmatter omits
 * title/description and must never wipe a human's curation — but the big
 * content cap (the wire already enforced chars/bytes; `assertProjectable`
 * inside the upsert re-checks exact deliverability on the merged state).
 * Metadata is re-normalized here so the DB only ever holds render-stable
 * values, whatever the harvester sent.
 */
export const saveMemoryFromFile = async (
  workspaceId: string,
  agentId: string,
  input: MemoryInput,
  author: MemoryAuthor,
): Promise<{ memory: AgentMemoryView; created: boolean; noop: boolean }> => {
  const content = input.content.trim();
  if (content.length === 0) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "The memory file has no content. Write the memory before it can sync",
    );
  }
  // The wire schema already refuses this at the route; the service repeats
  // it (the belt-and-braces law) so no future caller can save what the
  // dashboard editor and the harvester both consider over-cap.
  if (content.length > MEMORY_FILE_CONTENT_MAX_CHARS) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Memory content is limited to ${MEMORY_FILE_CONTENT_MAX_CHARS.toLocaleString("en-US")} characters: split it into linked memories`,
    );
  }
  const title =
    input.title === undefined ? undefined : flattenToLine(input.title);
  const description =
    input.description === undefined
      ? undefined
      : flattenToLine(input.description);
  return upsertMemoryByKey(
    workspaceId,
    agentId,
    {
      key: input.key,
      content,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    },
    author,
  );
};

export const deleteMemory = async (
  workspaceId: string,
  agentId: string,
  memoryId: string,
): Promise<void> => {
  await requireHostedAgent(workspaceId, agentId);
  const { count } = await db.agentMemory.deleteMany({
    where: { id: memoryId, agentId },
  });
  if (count === 0) throw new ServiceError("NOT_FOUND", "Memory not found");
  // The projection's prune is what carries a deletion into the sandbox.
  await bumpHomeForAgent(agentId);
};

/** A list-row revision: content clipped to a preview (the history sheet
 * fetches one full revision on selection — see MEMORY_REVISION_PREVIEW_CHARS). */
export type MemoryRevisionPreview = MemoryRevisionView & {
  contentTruncated: boolean;
};

const toRevisionPreview = (
  revision: MemoryRevisionView,
): MemoryRevisionPreview => ({
  ...revision,
  content: revision.content.slice(0, MEMORY_REVISION_PREVIEW_CHARS),
  contentTruncated: revision.content.length > MEMORY_REVISION_PREVIEW_CHARS,
});

export const listRevisions = async (
  workspaceId: string,
  agentId: string,
  memoryId: string,
): Promise<MemoryRevisionPreview[]> => {
  await requireHostedAgent(workspaceId, agentId);
  const memory = await db.agentMemory.findFirst({
    where: { id: memoryId, agentId },
    select: { id: true },
  });
  if (!memory) throw new ServiceError("NOT_FOUND", "Memory not found");
  const revisions = await db.agentMemoryRevision.findMany({
    where: { memoryId },
    orderBy: { seq: "desc" },
    select: revisionSelect,
  });
  return revisions.map(toRevisionPreview);
};

/** One full revision — the history sheet's on-selection read. Fenced the
 * same way as every revision op: the (memory, agent) pair first, then the
 * (revision, memory) pair, so foreign ids read as NOT_FOUND, never a hint. */
export const getRevision = async (
  workspaceId: string,
  agentId: string,
  memoryId: string,
  revisionId: string,
): Promise<MemoryRevisionView> => {
  await requireHostedAgent(workspaceId, agentId);
  const memory = await db.agentMemory.findFirst({
    where: { id: memoryId, agentId },
    select: { id: true },
  });
  if (!memory) throw new ServiceError("NOT_FOUND", "Memory not found");
  const revision = await db.agentMemoryRevision.findFirst({
    where: { id: revisionId, memoryId },
    select: revisionSelect,
  });
  if (!revision) throw new ServiceError("NOT_FOUND", "Revision not found");
  return revision;
};

const requireRevision = async (
  agentId: string,
  memoryId: string,
  revisionId: string,
) => {
  const memory = await db.agentMemory.findFirst({
    where: { id: memoryId, agentId },
    select: { id: true, lastRevisionSeq: true },
  });
  if (!memory) throw new ServiceError("NOT_FOUND", "Memory not found");
  const revision = await db.agentMemoryRevision.findFirst({
    where: { id: revisionId, memoryId },
    select: revisionSelect,
  });
  if (!revision) throw new ServiceError("NOT_FOUND", "Revision not found");
  return { memory, revision };
};

export const restoreRevision = async (
  workspaceId: string,
  agentId: string,
  memoryId: string,
  revisionId: string,
  author: MemoryAuthor,
): Promise<AgentMemoryView> => {
  await requireHostedAgent(workspaceId, agentId);
  const { memory, revision } = await requireRevision(
    agentId,
    memoryId,
    revisionId,
  );
  if (revision.seq === memory.lastRevisionSeq) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This is already the current version",
    );
  }
  if (revision.redactedAt) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This revision was redacted: its content is gone",
    );
  }
  return applyState(
    memoryId,
    {
      title: revision.title,
      description: revision.description,
      content: revision.content,
    },
    "restore",
    revision.seq,
    author,
  );
};

/**
 * The one deliberate history rewrite: scrub a snapshot in place. The latest
 * revision is refused because the head mirrors it — redacting it would leave
 * the leak live; author/op/time metadata survive (they are not the secret).
 */
export const redactRevision = async (
  workspaceId: string,
  agentId: string,
  memoryId: string,
  revisionId: string,
  redactedByUserId: string | null,
): Promise<MemoryRevisionView> => {
  await requireHostedAgent(workspaceId, agentId);
  const { memory, revision } = await requireRevision(
    agentId,
    memoryId,
    revisionId,
  );
  if (revision.seq === memory.lastRevisionSeq) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This is the current version: edit or delete the memory first, then redact the old revision",
    );
  }
  if (revision.redactedAt) {
    throw new ServiceError("UNPROCESSABLE", "Already redacted");
  }
  return db.agentMemoryRevision.update({
    where: { id: revision.id },
    data: {
      title: null,
      description: null,
      content: REDACTED_CONTENT,
      redactedAt: new Date(),
      redactedByUserId,
    },
    select: revisionSelect,
  });
};

interface MemorySearchRow {
  id: string;
  key: string;
  title: string | null;
  description: string | null;
  updatedAt: Date;
  rank: number;
  snippet: string;
}

const escapeLike = (value: string): string =>
  value.replace(/[\\%_]/g, (match) => `\\${match}`);

const HEADLINE_OPTIONS =
  'StartSel=**, StopSel=**, MaxWords=30, MinWords=8, MaxFragments=2, FragmentDelimiter=" … "';

/**
 * Ranked full-text search over one agent's memories, with a highlighted
 * snippet per hit.
 *
 * Design (decided at planning): built-in FTS at QUERY time — no stored
 * tsvector, no expression index, no extension. MAX_MEMORIES_PER_AGENT bounds
 * the scan (≤100 rows × ≤12k chars: milliseconds), which is also what keeps
 * Prisma's migration-drift describer out of the picture. Two layers so
 * ts_headline (an expensive re-parse) runs only on the LIMIT rows. Weights:
 * key/title A (1.0), description B (0.4), content C (0.2); normalization 32
 * maps rank into (0,1) so the injection floor has a stable scale. The ILIKE
 * arm on key/title recovers partial-handle lookups ("eploy-no") that FTS
 * stemming misses — content is deliberately excluded from it (substring hits
 * there carry rank 0 and meaningless snippets). websearch_to_tsquery never
 * throws on arbitrary prose, which is why it is safe for raw turn messages.
 *
 * Callers own the fence: the route door passes a requireHostedAgent-checked
 * pair; the tool door's agentId comes from the runner's two-fact identity;
 * the turn-dispatch builder's from the claim row.
 */
export const searchMemories = async (
  agentId: string,
  query: string,
  limit: number = MEMORY_SEARCH_LIMIT,
): Promise<MemorySearchHit[]> => {
  const like = `%${escapeLike(query)}%`;
  return db.$queryRaw<MemorySearchRow[]>`
    SELECT
      hit."id", hit."key", hit."title", hit."description",
      hit."updatedAt", hit."rank",
      ts_headline(
        'english', hit."content",
        websearch_to_tsquery('english', ${query}),
        ${HEADLINE_OPTIONS}
      ) AS "snippet"
    FROM (
      SELECT
        m."id", m."key", m."title", m."description", m."content",
        m."updated_at" AS "updatedAt",
        ts_rank(
          setweight(to_tsvector('english', m."key"), 'A') ||
          setweight(to_tsvector('english', coalesce(m."title", '')), 'A') ||
          setweight(to_tsvector('english', coalesce(m."description", '')), 'B') ||
          setweight(to_tsvector('english', m."content"), 'C'),
          websearch_to_tsquery('english', ${query}),
          32
        ) AS "rank"
      FROM "agent_memories" m
      WHERE m."agent_id" = ${agentId}
        AND (
          to_tsvector('english',
            concat_ws(' ', m."key", m."title", m."description", m."content"))
            @@ websearch_to_tsquery('english', ${query})
          OR m."key" ILIKE ${like}
          OR m."title" ILIKE ${like}
        )
      ORDER BY "rank" DESC, m."updated_at" DESC
      LIMIT ${limit}
    ) hit
    ORDER BY hit."rank" DESC, hit."updatedAt" DESC
  `;
};

/** The fenced search door for the dashboard's ?q=. */
export const searchMemoriesForWorkspace = async (
  workspaceId: string,
  agentId: string,
  query: string,
  limit: number = MEMORY_SEARCH_LIMIT,
): Promise<MemorySearchHit[]> => {
  await requireHostedAgent(workspaceId, agentId);
  return searchMemories(agentId, query, limit);
};

/** How full this agent's memory is — memory_list's pressure counts. */
export const memoryPressure = async (
  agentId: string,
): Promise<{ held: number; max: number }> => {
  const held = await db.agentMemory.count({ where: { agentId } });
  return { held, max: MAX_MEMORIES_PER_AGENT };
};
