import { apiDelete, apiGet, apiPatch, apiPost } from "./client";

/**
 * The agent-memory client (step 8): /v1/agents/:agentId/memories. Types are
 * hand-mirrored from the service views (`agent-memory-service.ts`), dates as
 * ISO strings — the house convention for the typed client.
 */

/** The index row — deliberately body-free; the detail fetch carries content. */
export interface AgentMemorySummary {
  id: string;
  agentId: string;
  key: string;
  title: string | null;
  description: string | null;
  lastRevisionSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRevision {
  id: string;
  seq: number;
  /** "save" | "restore" */
  op: string;
  restoredFromSeq: number | null;
  title: string | null;
  description: string | null;
  content: string;
  /** "user" | "agent" */
  authorKind: string;
  authorUserId: string | null;
  authorEmail: string | null;
  conversationId: string | null;
  turnId: string | null;
  redactedAt: string | null;
  redactedByUserId: string | null;
  createdAt: string;
}

/** A list-row revision: `content` is a PREVIEW when `contentTruncated` —
 * fetch the full body with `revision()` on selection (at the 100k file cap
 * a full list would be a multi-megabyte response). */
export interface MemoryRevisionPreview extends MemoryRevision {
  contentTruncated: boolean;
}

export interface AgentMemory extends AgentMemorySummary {
  content: string;
  latestRevision: MemoryRevision | null;
}

export interface MemorySearchHit {
  id: string;
  key: string;
  title: string | null;
  description: string | null;
  snippet: string;
  rank: number;
  updatedAt: string;
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

// Encoded like `agents.get`: ids can arrive DECODED from the URL
// (`useParams`), and an unencoded crafted segment would URL-normalize the
// request onto a different /v1 path under the caller's credentials.
const memoryBase = (agentId: string, sub = "") =>
  `/v1/agents/${encodeURIComponent(agentId)}/memories${sub}`;

export const list = (agentId: string) =>
  apiGet<{ memories: AgentMemorySummary[] }>(memoryBase(agentId));

export const search = (agentId: string, query: string) =>
  apiGet<{ hits: MemorySearchHit[] }>(
    memoryBase(agentId, `?q=${encodeURIComponent(query)}`),
  );

export const get = (agentId: string, memoryId: string) =>
  apiGet<AgentMemory>(memoryBase(agentId, `/${encodeURIComponent(memoryId)}`));

export const create = (agentId: string, input: MemoryInput) =>
  apiPost<AgentMemory>(memoryBase(agentId), input);

export const update = (agentId: string, memoryId: string, patch: MemoryPatch) =>
  apiPatch<AgentMemory>(
    memoryBase(agentId, `/${encodeURIComponent(memoryId)}`),
    patch,
  );

export const remove = (agentId: string, memoryId: string) =>
  apiDelete(memoryBase(agentId, `/${encodeURIComponent(memoryId)}`));

export const revisions = (agentId: string, memoryId: string) =>
  apiGet<{ revisions: MemoryRevisionPreview[] }>(
    memoryBase(agentId, `/${encodeURIComponent(memoryId)}/revisions`),
  );

export const revision = (
  agentId: string,
  memoryId: string,
  revisionId: string,
) =>
  apiGet<MemoryRevision>(
    memoryBase(
      agentId,
      `/${encodeURIComponent(memoryId)}/revisions/${encodeURIComponent(revisionId)}`,
    ),
  );

export const restore = (
  agentId: string,
  memoryId: string,
  revisionId: string,
) =>
  apiPost<AgentMemory>(
    memoryBase(
      agentId,
      `/${encodeURIComponent(memoryId)}/revisions/${encodeURIComponent(revisionId)}/restore`,
    ),
    {},
  );

export const redact = (agentId: string, memoryId: string, revisionId: string) =>
  apiPost<MemoryRevision>(
    memoryBase(
      agentId,
      `/${encodeURIComponent(memoryId)}/revisions/${encodeURIComponent(revisionId)}/redact`,
    ),
    {},
  );
