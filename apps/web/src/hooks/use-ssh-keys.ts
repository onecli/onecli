"use client";

// No gateway-cache involvement: the gateway reads no SSH state, so neither
// these hooks nor the API routes flush it. Create is HEADLESS (the
// use-crons convention): both surfaces — the account card and the agent SSH
// page — render refusals inline as states (409 duplicate/cap, 422 not
// ed25519), and the new row appearing IS the confirmation.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sshKeys } from "@/lib/api";
import type { SshKey } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { listItem, patchItem } from "@/lib/api/optimistic";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";

export const useSshKeys = () =>
  useQuery({
    queryKey: queryKeys.sshKeys.list(),
    queryFn: () => sshKeys.list(),
  });

export const useCreateSshKey = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; publicKey: string }) =>
      sshKeys.create(input),
    // Returned: the new row appearing IS the confirmation, so the form
    // stays busy until it has.
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.sshKeys.all() }),
  });
};

/** Delete an SSH key, instantly: the row disappearing IS the success
 * signal, so it disappears on click; a failure puts it back and says why. */
export const useDeleteSshKey = () =>
  useOptimisticMutation<void, string>({
    family: "ssh-keys",
    itemKey: (id) => `ssh-key:${id}`,
    write: (id) => sshKeys.remove(id),
    apply: (qc, id) =>
      patchItem(
        qc,
        queryKeys.sshKeys.list(),
        listItem<SshKey>((k) => k.id === id),
        () => undefined,
      ),
    refresh: (qc) =>
      qc.invalidateQueries({ queryKey: queryKeys.sshKeys.all() }),
    failure: (qc, id) => {
      const name = qc
        .getQueryData<SshKey[]>(queryKeys.sshKeys.list())
        ?.find((k) => k.id === id)?.name;
      return `Couldn't delete ${name ? `"${name}"` : "the SSH key"}`;
    },
  });
