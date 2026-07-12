"use client";

// Require-SSO is a LOGIN policy — no gateway-cache involvement (agent
// traffic is unaffected), so neither these hooks nor the API routes flush
// the gateway. Same posture as use-domains / use-sso-connections.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ssoEnforcement } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

export const useSsoEnforcement = () =>
  useQuery({
    queryKey: queryKeys.ssoEnforcement.get(),
    queryFn: () => ssoEnforcement.get(),
  });

export const useUpdateSsoEnforcement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ssoRequired: boolean) => ssoEnforcement.update(ssoRequired),
    onSuccess: (state) => {
      qc.invalidateQueries({ queryKey: queryKeys.ssoEnforcement.all() });
      toast.success(
        state.ssoRequired
          ? "Single sign-on is now required for this organization"
          : "Single sign-on is no longer required",
      );
    },
    // Surface the server reason (missing precondition, plan gate).
    onError: (err) => toast.error(err.message),
  });
};
