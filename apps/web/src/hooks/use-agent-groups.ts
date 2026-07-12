"use client";

// No client-side gateway flush here: agent-group mutations run through
// audited API routes that flush the gateway server-side.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { agentGroups } from "@/lib/api";
import { fetchAllPages } from "@/lib/api/pagination";
import { queryKeys } from "@/lib/api/keys";

const PAGE_LIMIT = 200;

export const useAgentGroups = (options: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: queryKeys.agentGroups.list(),
    queryFn: () =>
      fetchAllPages((cursor) =>
        agentGroups.list({ limit: PAGE_LIMIT, cursor }),
      ),
    enabled: options.enabled ?? true,
    // The agent-create picker mounts this for every user; members get a 403
    // (directory routes are admin-only) which is expected, not retryable.
    retry: false,
  });

// Drained fully (not one page): the members dialog saves a replace-set, so a
// truncated read would silently drop the unseen members on save.
export const useAgentGroupMembers = (groupId: string, enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.agentGroups.members(groupId),
    queryFn: () =>
      fetchAllPages((cursor) =>
        agentGroups.members(groupId, { limit: PAGE_LIMIT, cursor }),
      ),
    enabled,
  });

export const useCreateAgentGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => agentGroups.create(name),
    onSuccess: (group) => {
      qc.invalidateQueries({ queryKey: queryKeys.agentGroups.all() });
      toast.success(`Agent group "${group.name}" created`);
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useRenameAgentGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, name }: { groupId: string; name: string }) =>
      agentGroups.rename(groupId, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agentGroups.all() });
      toast.success("Agent group renamed");
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useDeleteAgentGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => agentGroups.remove(groupId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agentGroups.all() });
      toast.success("Agent group deleted");
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useSetAgentGroupMembers = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      groupId,
      agentIds,
    }: {
      groupId: string;
      agentIds: string[];
    }) => agentGroups.setMembers(groupId, agentIds),
    onSuccess: (_result, { groupId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.agentGroups.all() });
      qc.invalidateQueries({
        queryKey: queryKeys.agentGroups.members(groupId),
      });
    },
    onError: (err) => toast.error(err.message),
  });
};

/** Assign a just-created agent to a group (the create-dialog picker's save). */
export const useAddAgentToGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, agentId }: { groupId: string; agentId: string }) =>
      agentGroups.addMember(groupId, agentId),
    onSuccess: (_result, { groupId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.agentGroups.all() });
      qc.invalidateQueries({
        queryKey: queryKeys.agentGroups.members(groupId),
      });
    },
    onError: (err) => toast.error(err.message),
  });
};
