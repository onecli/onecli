"use client";

import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { skillLibrary, type LibrarySkill } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import {
  listItem,
  patchItem,
  throughField,
  type Rollback,
} from "@/lib/api/optimistic";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";

// The skill library. Mutations are headless (the skills convention): the
// components own the toasts, except the instant switch, whose failure toast
// comes from the shared optimistic-write helper. Every mutation sweeps the
// skills namespace, so an add also refreshes the agent's list. No gateway
// flush: the gateway reads no skill table.

/** "No library is connected" (404), as opposed to a read that failed. */
export const isNoLibrary = (error: unknown) =>
  error instanceof ApiError && error.status === 404;

/** A read of a live repo listing: a 404 means "no library", so it is never
 * retried; anything else (GitHub down, a timeout) gets the normal retries. */
const retryUnlessNoLibrary = (failures: number, error: Error) =>
  !isNoLibrary(error) && failures < 2;

export const useOrgSkillLibrary = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.skills.library(),
    queryFn: skillLibrary.orgLibrary,
    enabled,
  });

/** The live repo listing (org door). 404 = no repo connected. */
export const useOrgRepoSkills = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.skills.orgRepo(),
    queryFn: skillLibrary.orgRepoSkills,
    enabled,
    staleTime: 60_000,
    retry: retryUnlessNoLibrary,
  });

export const useAgentLibrarySkills = (agentId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.skills.agentLibrary(agentId),
    queryFn: () => skillLibrary.agentLibrary(agentId),
    enabled: enabled && agentId !== "",
  });

/** The live repo listing marked with what this agent holds. */
export const useAgentAvailableLibrarySkills = (
  agentId: string,
  enabled = true,
) =>
  useQuery({
    queryKey: queryKeys.skills.agentAvailable(agentId),
    queryFn: () => skillLibrary.agentAvailable(agentId),
    enabled,
    staleTime: 60_000,
    retry: retryUnlessNoLibrary,
  });

const useSweep = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: queryKeys.skills.all() });
};

export const useConnectSkillLibrary = () => {
  const sweep = useSweep();
  return useMutation({
    mutationFn: skillLibrary.connect,
    onSuccess: sweep,
  });
};

export const useDisconnectSkillLibrary = () => {
  const sweep = useSweep();
  return useMutation({
    mutationFn: skillLibrary.disconnect,
    onSuccess: sweep,
  });
};

export const useResyncLibrarySkill = () => {
  const sweep = useSweep();
  return useMutation({
    mutationFn: (name: string) => skillLibrary.resync(name),
    onSuccess: sweep,
  });
};

/**
 * Add library skills to the agent: one, or "Add all" (in turn, since each
 * add fetches a folder from GitHub), reporting progress. A failure stops the
 * run and says how far it got; what was added stays added.
 */
export const useAttachLibrarySkills = (agentId: string) => {
  const sweep = useSweep();
  return useMutation({
    mutationFn: async ({
      names,
      onProgress,
    }: {
      names: string[];
      onProgress: (done: number) => void;
    }) => {
      for (const [index, name] of names.entries()) {
        onProgress(index);
        try {
          await skillLibrary.attach(agentId, name);
        } catch (err) {
          const reason = err instanceof Error ? err.message : "Unknown error";
          throw new Error(
            index === 0
              ? `Couldn't add ${name}: ${reason}`
              : `Added ${index} of ${names.length}. Couldn't add ${name}: ${reason}`,
          );
        }
      }
      onProgress(names.length);
    },
    onSettled: sweep,
  });
};

export const useDetachLibrarySkill = (agentId: string) => {
  const sweep = useSweep();
  return useMutation({
    mutationFn: (name: string) => skillLibrary.detach(agentId, name),
    onSuccess: sweep,
  });
};

const librarySkillIn = (name: string) =>
  throughField<{ skills: LibrarySkill[] }, "skills", LibrarySkill>(
    "skills",
    listItem((s) => s.name === name),
  );

/**
 * The agent's on/off switch for a library skill it holds, instantly: the
 * switch moves on click, the write follows in click order, and a failure
 * puts it back and says why (the same behavior as a regular skill's switch).
 */
export const useSetLibrarySkillEnabled = (agentId: string) =>
  useOptimisticMutation<LibrarySkill, { name: string; enabled: boolean }>({
    family: "library-skills",
    itemKey: ({ name }) => `library-skill:${agentId}:${name}`,
    write: ({ name, enabled }) =>
      skillLibrary.setEnabled(agentId, name, enabled),
    apply: (qc, { name, enabled }): Rollback =>
      patchItem(
        qc,
        queryKeys.skills.agentLibrary(agentId),
        librarySkillIn(name),
        (s) => (s ? { ...s, enabled } : s),
      ),
    refresh: (qc) => qc.invalidateQueries({ queryKey: queryKeys.skills.all() }),
    failure: (_, { name, enabled }) =>
      `Couldn't ${enabled ? "resume" : "pause"} "${name}"`,
  });

/** The repos the library could read with `access` (null = not chosen yet).
 * Keyed by the access, so switching accounts re-reads. */
export const useLibraryAccessRepos = (
  access: skillLibrary.LibraryAccess | null,
) =>
  useQuery({
    queryKey: queryKeys.skills.accessRepos(
      access ? JSON.stringify(access) : "",
    ),
    queryFn: access ? () => skillLibrary.accessRepos(access) : skipToken,
    staleTime: 0,
  });

/** The org-level GitHub accounts the library may reuse. */
export const useLibraryGitHubAccounts = () =>
  useQuery({
    queryKey: queryKeys.skills.githubAccounts(),
    queryFn: skillLibrary.githubAccounts,
  });
