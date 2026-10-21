"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { skills } from "@/lib/api";
import type { Skill, SkillInput, SkillPatch, SkillSummary } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import {
  combineRollbacks,
  listItem,
  patchItem,
  throughField,
  wholeValue,
} from "@/lib/api/optimistic";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";
import { toast } from "sonner";

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
    // Returned: Saving… lasts until the new row is listed.
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.skills.all() }),
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
      return qc.invalidateQueries({ queryKey: queryKeys.skills.all() });
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
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.skills.all() }),
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
      return qc.invalidateQueries({ queryKey: queryKeys.skills.all() });
    },
  });
};

const skillInList = (skillId: string) =>
  throughField<{ skills: SkillSummary[] }, "skills", SkillSummary>(
    "skills",
    listItem((s) => s.id === skillId),
  );

const skillName = (qc: QueryClient, skillId: string) => {
  for (const [, data] of qc.getQueriesData<{ skills: SkillSummary[] }>({
    queryKey: queryKeys.skills.all(),
  })) {
    const found = skillInList(skillId).get(data ?? { skills: [] });
    if (found) return found.name;
  }
  return undefined;
};

/**
 * Pause / resume a skill from its row's switch, instantly, on either door
 * (the agent/workspace list or the org list): the click patches the skill
 * in every cached list and detail that holds it.
 */
export const useSetSkillEnabled = (isOrg: boolean) =>
  useOptimisticMutation<Skill, { skillId: string; enabled: boolean }>({
    family: "skills",
    itemKey: ({ skillId }) => `skill:${skillId}`,
    write: ({ skillId, enabled }) =>
      isOrg
        ? skills.orgUpdate(skillId, { enabled })
        : skills.update(skillId, { enabled }),
    apply: (qc, { skillId, enabled }) =>
      combineRollbacks(
        patchItem(qc, queryKeys.skills.list(), skillInList(skillId), (s) =>
          s ? { ...s, enabled } : s,
        ),
        patchItem(qc, queryKeys.skills.org(), skillInList(skillId), (s) =>
          s ? { ...s, enabled } : s,
        ),
        patchItem(
          qc,
          isOrg
            ? queryKeys.skills.orgDetail(skillId)
            : queryKeys.skills.detail(skillId),
          wholeValue<Skill>(),
          (s) => (s ? { ...s, enabled } : s),
        ),
      ),
    refresh: (qc) => qc.invalidateQueries({ queryKey: queryKeys.skills.all() }),
    failure: (qc, { skillId, enabled }) =>
      `Couldn't ${enabled ? "resume" : "pause"} "${skillName(qc, skillId) ?? "the skill"}"`,
  });

/** Delete a skill, instantly, from either door: it leaves every cached
 * list on click (the dialog closes with it); the confirmation follows the
 * server, and a failure puts the row back. */
const useRemoveSkill = (isOrg: boolean) =>
  useOptimisticMutation<void, string>({
    family: "skills",
    itemKey: (skillId) => `skill:${skillId}`,
    write: (skillId) =>
      isOrg ? skills.orgRemove(skillId) : skills.remove(skillId),
    apply: (qc, skillId) =>
      combineRollbacks(
        patchItem(
          qc,
          queryKeys.skills.list(),
          skillInList(skillId),
          () => undefined,
        ),
        patchItem(
          qc,
          queryKeys.skills.org(),
          skillInList(skillId),
          () => undefined,
        ),
      ),
    succeeded: () => toast.success("Skill deleted"),
    refresh: (qc) => qc.invalidateQueries({ queryKey: queryKeys.skills.all() }),
    failure: (qc, skillId) =>
      `Couldn't delete "${skillName(qc, skillId) ?? "the skill"}"`,
  });

export const useDeleteSkill = () => useRemoveSkill(false);

export const useDeleteOrgSkill = () => useRemoveSkill(true);
