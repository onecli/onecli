"use client";

// No gateway-cache involvement: domains never affect agent traffic routing,
// so neither these hooks nor the API routes flush the gateway.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { domains } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

export const useDomains = () =>
  useQuery({
    queryKey: queryKeys.domains.list(),
    queryFn: () => domains.list(),
  });

export const useCreateDomain = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => domains.create(domain),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.domains.all() });
      toast.success("Domain added — publish the TXT record to verify it");
    },
    // Surface the server reason (blocklist, already claimed, invalid shape).
    onError: (err) => toast.error(err.message),
  });
};

export const useVerifyDomain = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) => domains.verify(domainId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.domains.all() });
      toast.success("Domain verified");
    },
    // Usually "TXT record not found yet" — show the server message.
    onError: (err) => toast.error(err.message),
  });
};

export const useDeleteDomain = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) => domains.remove(domainId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.domains.all() });
      toast.success("Domain removed");
    },
    onError: () => toast.error("Failed to remove domain"),
  });
};
