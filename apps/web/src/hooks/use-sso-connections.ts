"use client";

// No gateway-cache involvement: SSO connections configure login, not agent
// traffic — neither these hooks nor the API routes flush the gateway.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ssoConnections } from "@/lib/api";
import type {
  CreateSsoConnectionInput,
  UpdateSsoConnectionInput,
} from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

export const useSsoConnections = () =>
  useQuery({
    queryKey: queryKeys.ssoConnections.list(),
    queryFn: () => ssoConnections.list(),
  });

export const useCreateSsoConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSsoConnectionInput) =>
      ssoConnections.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.ssoConnections.all() });
      toast.success("SSO connection created");
    },
    // Surface the server reason (duplicate, Cognito rejection, lock busy).
    onError: (err) => toast.error(err.message),
  });
};

export const useUpdateSsoConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      connectionId,
      input,
    }: {
      connectionId: string;
      input: UpdateSsoConnectionInput;
    }) => ssoConnections.update(connectionId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.ssoConnections.all() });
      toast.success("SSO connection updated");
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useDeleteSsoConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => ssoConnections.remove(connectionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.ssoConnections.all() });
      toast.success("SSO connection removed");
    },
    onError: (err) => toast.error(err.message),
  });
};

// Returns the per-check results for inline rendering — the caller decides
// how to present them; only hard errors toast.
export const useTestSsoConnection = () =>
  useMutation({
    mutationFn: (connectionId: string) => ssoConnections.test(connectionId),
    onError: (err) => toast.error(err.message),
  });
