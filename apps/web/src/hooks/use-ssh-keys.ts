"use client";

// No gateway-cache involvement: the gateway reads no SSH state, so neither
// these hooks nor the API routes flush it. Create is HEADLESS (the
// use-crons convention): both surfaces — the account card and the agent SSH
// page — render refusals inline as states (409 duplicate/cap, 422 not
// ed25519), and the new row appearing IS the confirmation.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sshKeys } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.sshKeys.all() });
    },
  });
};

export const useDeleteSshKey = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sshKeys.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.sshKeys.all() });
    },
    // The row disappearing is the success signal; only failures speak.
    onError: () => toast.error("Failed to delete the SSH key"),
  });
};
