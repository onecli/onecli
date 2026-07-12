"use client";

// No client-side gateway flush here: role-mapping mutations run through audited
// API routes that flush the gateway server-side (withAudit's org invalidation).
// Mutations also invalidate the org-members query (the directory picker's cached
// roles); the team page renders the lock from a server component, so it refreshes
// on navigation rather than from this invalidation.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { roleMappings } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type {
  CreateRoleMappingInput,
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

const invalidateAll = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: queryKeys.roleMappings.all() });
  // Applying a mapping can change member roles (see the org-members note above).
  qc.invalidateQueries({ queryKey: queryKeys.orgMembers.all() });
};

export const useCreateRoleMapping = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoleMappingInput) => roleMappings.create(input),
    onSuccess: () => {
      invalidateAll(qc);
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
    onSuccess: () => {
      invalidateAll(qc);
      toast.success("Role mapping updated");
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useDeleteRoleMapping = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => roleMappings.remove(id),
    onSuccess: () => {
      invalidateAll(qc);
      toast.success("Role mapping removed");
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useReorderRoleMappings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: string[]) => roleMappings.reorder(orderedIds),
    onSuccess: () => invalidateAll(qc),
    onError: (err) => toast.error(err.message),
  });
};
