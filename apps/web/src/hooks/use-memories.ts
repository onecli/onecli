"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { memories } from "@/lib/api";
import type {
  AgentMemory,
  AgentMemorySummary,
  MemoryInput,
  MemoryPatch,
} from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { listItem, patchItem, throughField } from "@/lib/api/optimistic";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";

// Memory mutations are headless (the crons/channels convention): the Memory
// section owns the toasts — a save, a restore, and a redact want different
// copy. No `invalidateGatewayCache()` anywhere — deliberate: the gateway
// reads no memory table, so a flush would be pure noise. Every read here is
// GET-backed, so the `memories.all()` namespace sweep is safe (the
// direct-thread PUT-door lesson does not apply).

export const useMemories = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.memories.agent(agentId),
    queryFn: () => memories.list(agentId),
  });

export const useMemory = (agentId: string, memoryId: string | null) =>
  useQuery({
    queryKey: queryKeys.memories.detail(agentId, memoryId ?? "none"),
    queryFn: () => memories.get(agentId, memoryId as string),
    enabled: memoryId !== null,
  });

export const useMemoryRevisions = (agentId: string, memoryId: string | null) =>
  useQuery({
    queryKey: queryKeys.memories.revisions(agentId, memoryId ?? "none"),
    queryFn: () => memories.revisions(agentId, memoryId as string),
    enabled: memoryId !== null,
  });

/** One FULL revision — fetched only when a preview row says its content was
 * clipped (`contentTruncated`), so opening the sheet never pulls megabytes. */
export const useMemoryRevision = (
  agentId: string,
  memoryId: string | null,
  revisionId: string | null,
) =>
  useQuery({
    queryKey: queryKeys.memories.revision(
      agentId,
      memoryId ?? "none",
      revisionId ?? "none",
    ),
    queryFn: () =>
      memories.revision(agentId, memoryId as string, revisionId as string),
    enabled: memoryId !== null && revisionId !== null,
  });

export const useCreateMemory = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MemoryInput) => memories.create(agentId, input),
    // Returned, so the dialog's Saving… lasts until the new row is listed
    // (no close-then-pop-in).
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.memories.all() }),
  });
};

export const useUpdateMemory = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      memoryId,
      patch,
    }: {
      memoryId: string;
      patch: MemoryPatch;
    }) => memories.update(agentId, memoryId, patch),
    onSuccess: (updated, { memoryId }) => {
      // Seed what we just wrote before refetching: the editor falls back to
      // the cached value the moment its draft clears, so an invalidate alone
      // would flash the PREVIOUS text until the refetch lands (the
      // instructions-editor lesson, use-agents.ts).
      qc.setQueryData(
        queryKeys.memories.detail(agentId, memoryId),
        (prev?: AgentMemory) => (prev ? { ...prev, ...updated } : updated),
      );
      return qc.invalidateQueries({ queryKey: queryKeys.memories.all() });
    },
  });
};

const memoryRow = (memoryId: string) =>
  throughField<
    { memories: AgentMemorySummary[] },
    "memories",
    AgentMemorySummary
  >(
    "memories",
    listItem((m) => m.id === memoryId),
  );

/** Delete a memory, instantly: it leaves the list (and its dialog closes)
 * on click; the confirmation follows the server, and a failure puts the
 * row back. */
export const useDeleteMemory = (agentId: string) =>
  useOptimisticMutation<void, string>({
    family: `memories:${agentId}`,
    itemKey: (memoryId) => `memory:${agentId}:${memoryId}`,
    write: (memoryId) => memories.remove(agentId, memoryId),
    apply: (qc, memoryId) =>
      patchItem(
        qc,
        queryKeys.memories.agent(agentId),
        memoryRow(memoryId),
        () => undefined,
      ),
    succeeded: () => toast.success("Memory deleted"),
    refresh: (qc) =>
      qc.invalidateQueries({ queryKey: queryKeys.memories.all() }),
    failure: (qc, memoryId) => {
      const data = qc.getQueryData<{ memories: AgentMemorySummary[] }>(
        queryKeys.memories.agent(agentId),
      );
      const memory = data && memoryRow(memoryId).get(data);
      return `Couldn't delete ${memory ? `"${memory.title ?? memory.key}"` : "the memory"}`;
    },
  });

export const useRestoreRevision = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      memoryId,
      revisionId,
    }: {
      memoryId: string;
      revisionId: string;
    }) => memories.restore(agentId, memoryId, revisionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.memories.all() });
    },
  });
};

export const useRedactRevision = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      memoryId,
      revisionId,
    }: {
      memoryId: string;
      revisionId: string;
    }) => memories.redact(agentId, memoryId, revisionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.memories.all() });
    },
  });
};
