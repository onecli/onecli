"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { skills } from "@/lib/api";
import type { Skill, SkillInput, SkillPatch } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// Skill mutations are headless (the crons/memories convention): the section
// owns the toasts. No `invalidateGatewayCache()` — the gateway reads no
// skill table. Every read is GET-backed, so the namespace sweep is safe.
//
// Both list reads take `enabled` (the `useAgents` precedent) because the
// section renders both doors and must mount only the one it shows: the
// workspace read carries no workspace header from an /org/ URL, which is a 401 on
// cloud and — worse — silently resolves the caller's DEFAULT workspace onprem
// (`resolveWorkspaceId`'s header-less fallback), caching another workspace's rows
// under an org-scoped key. The two doors also have SEPARATE key scopes (the
// URL-derived org/workspace ride `scope()`), so an org edit refreshes a workspace
// page only at its next mount, not through this sweep.

export const useSkills = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.skills.list(),
    queryFn: () => skills.list(),
    enabled,
  });

export const useSkill = (skillId: string | null) =>
  useQuery({
    queryKey: queryKeys.skills.detail(skillId ?? "none"),
    queryFn: () => skills.get(skillId as string),
    enabled: skillId !== null,
  });

export const useCreateSkill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SkillInput) => skills.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.skills.all() });
    },
  });
};

export const useUpdateSkill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ skillId, patch }: { skillId: string; patch: SkillPatch }) =>
      skills.update(skillId, patch),
    onSuccess: (updated, { skillId }) => {
      // Seed what we just wrote before refetching (the instructions-editor
      // flash lesson): the dialog's draft clears on success and falls back
      // to this cache entry.
      qc.setQueryData(queryKeys.skills.detail(skillId), (prev?: Skill) =>
        prev ? { ...prev, ...updated } : updated,
      );
      qc.invalidateQueries({ queryKey: queryKeys.skills.all() });
    },
  });
};

export const useDeleteSkill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) => skills.remove(skillId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.skills.all() });
    },
  });
};

export const useOrgSkills = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.skills.org(),
    queryFn: () => skills.orgList(),
    enabled,
  });

export const useOrgSkill = (skillId: string | null) =>
  useQuery({
    queryKey: queryKeys.skills.orgDetail(skillId ?? "none"),
    queryFn: () => skills.orgGet(skillId as string),
    enabled: skillId !== null,
  });

export const useCreateOrgSkill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<SkillInput, "agentId">) => skills.orgCreate(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.skills.all() });
    },
  });
};

export const useUpdateOrgSkill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ skillId, patch }: { skillId: string; patch: SkillPatch }) =>
      skills.orgUpdate(skillId, patch),
    onSuccess: (updated, { skillId }) => {
      qc.setQueryData(queryKeys.skills.orgDetail(skillId), (prev?: Skill) =>
        prev ? { ...prev, ...updated } : updated,
      );
      qc.invalidateQueries({ queryKey: queryKeys.skills.all() });
    },
  });
};

export const useDeleteOrgSkill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) => skills.orgRemove(skillId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.skills.all() });
    },
  });
};
