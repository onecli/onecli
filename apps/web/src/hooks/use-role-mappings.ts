"use client";

// No client-side gateway flush here: role-mapping mutations run through audited
// API routes that flush the gateway server-side (withAudit's org invalidation).
// Mutations also invalidate the org-members query (the directory picker's cached
// roles); the team page renders the lock from a server component, so it refreshes
// on navigation rather than from this invalidation.

import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { roleMappings } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { listItem, patchItem, wholeValue } from "@/lib/api/optimistic";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";
import type {
  CreateRoleMappingInput,
  RoleMappingRow,
  UpdateRoleMappingInput,
} from "@/lib/api/types";

export const useRoleMappings = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.roleMappings.list(),
    queryFn: () => roleMappings.list(),
    enabled,
  });

/** Live "N members would change role" for the create/edit dialog. */
export const useRoleMappingPreview = (
  input: { groupId: string; role: "admin" | "member" } | null,
) =>
  useQuery({
    queryKey: [...queryKeys.roleMappings.all(), "preview", input],
    queryFn: () => roleMappings.preview(input!),
    enabled: input !== null && input.groupId !== "",
  });

const refreshRoleMappings = (qc: QueryClient) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.roleMappings.all() }),
    // Applying a mapping can change member roles (see the org-members note above).
    qc.invalidateQueries({ queryKey: queryKeys.orgMembers.all() }),
  ]);

export const useCreateRoleMapping = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoleMappingInput) => roleMappings.create(input),
    onSuccess: async () => {
      // Awaited: the dialog closes onto a list that shows the new mapping.
      await refreshRoleMappings(qc);
      toast.success("Role mapping created");
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useUpdateRoleMapping = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: UpdateRoleMappingInput;
    }) => roleMappings.update(id, input),
    onSuccess: async () => {
      await refreshRoleMappings(qc);
      toast.success("Role mapping updated");
    },
    onError: (err) => toast.error(err.message),
  });
};

/** Remove a role mapping, instantly: the row leaves (and the confirm
 * closes) on click; the confirmation follows the server, and a failure
 * puts the row back. */
export const useDeleteRoleMapping = () =>
  useOptimisticMutation<void, string>({
    family: "role-mappings",
    itemKey: (id) => `role-mapping:${id}`,
    write: (id) => roleMappings.remove(id),
    apply: (qc, id) =>
      patchItem(
        qc,
        queryKeys.roleMappings.list(),
        listItem<RoleMappingRow>((m) => m.id === id),
        () => undefined,
      ),
    succeeded: () => toast.success("Role mapping removed"),
    refresh: refreshRoleMappings,
    failure: (qc, id) => {
      const group = qc
        .getQueryData<RoleMappingRow[]>(queryKeys.roleMappings.list())
        ?.find((m) => m.id === id)?.groupName;
      return `Couldn't remove the mapping${group ? ` for ${group}` : ""}`;
    },
  });

/**
 * Move a mapping up or down, instantly: the list reorders on click (with
 * the priorities the server will stamp), so the next click works from the
 * new order and needs no lock. Writes run in click order (one queue for the
 * whole list: each sends the full order), and a failure puts the order back.
 */
export const useReorderRoleMappings = () =>
  useOptimisticMutation<RoleMappingRow[], string[]>({
    family: "role-mappings",
    itemKey: () => "role-mappings:order",
    write: (orderedIds) => roleMappings.reorder(orderedIds),
    apply: (qc, orderedIds) =>
      patchItem(
        qc,
        queryKeys.roleMappings.list(),
        wholeValue<RoleMappingRow[]>(),
        (rows) => {
          if (!rows) return rows;
          const byId = new Map(rows.map((r) => [r.id, r]));
          // Descending, as the server stamps them: index 0 (the top) wins.
          const next = orderedIds.flatMap((id, i) => {
            const row = byId.get(id);
            return row ? [{ ...row, priority: orderedIds.length - i }] : [];
          });
          // A partial mapping means the cache and the click diverged: leave
          // it, and let the server's answer settle it.
          return next.length === rows.length ? next : rows;
        },
      ),
    confirm: (qc, rows) => qc.setQueryData(queryKeys.roleMappings.list(), rows),
    refresh: refreshRoleMappings,
    failure: () => "Couldn't reorder the role mappings",
  });
