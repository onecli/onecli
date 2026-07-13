"use client";

// No client-side gateway flush here: group mutations run through audited API
// routes that flush the gateway server-side (withAudit's org invalidation).

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { groups } from "@/lib/api";
import { fetchAllPages } from "@/lib/api/pagination";
import { queryKeys } from "@/lib/api/keys";

// The API pages with cursors (§3.5); the UI drains all pages and filters
// client-side (the connection-agents dialog pattern).
const PAGE_LIMIT = 200;

export const useGroups = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.groups.list(),
    queryFn: () =>
      fetchAllPages((cursor) => groups.list({ limit: PAGE_LIMIT, cursor })),
    enabled,
  });

// Drained fully (not one page): the members dialog saves a replace-set, so a
// truncated read would silently drop the unseen members on save.
export const useGroupMembers = (groupId: string, enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.groups.members(groupId),
    queryFn: () =>
      fetchAllPages((cursor) =>
        groups.members(groupId, { limit: PAGE_LIMIT, cursor }),
      ),
    enabled,
  });

export const useCreateGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => groups.create(name),
    onSuccess: (group) => {
      qc.invalidateQueries({ queryKey: queryKeys.groups.all() });
      toast.success(`Group "${group.name}" created`);
    },
    // Surface the server reason (duplicate name, plan gate).
    onError: (err) => toast.error(err.message),
  });
};

export const useRenameGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, name }: { groupId: string; name: string }) =>
      groups.rename(groupId, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.groups.all() });
      toast.success("Group renamed");
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useDeleteGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => groups.remove(groupId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.groups.all() });
      toast.success("Group deleted");
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useSetGroupMembers = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      groupId,
      userIds,
    }: {
      groupId: string;
      userIds: string[];
    }) => groups.setMembers(groupId, userIds),
    onSuccess: (_result, { groupId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.groups.all() });
      qc.invalidateQueries({ queryKey: queryKeys.groups.members(groupId) });
    },
    onError: (err) => toast.error(err.message),
  });
};
