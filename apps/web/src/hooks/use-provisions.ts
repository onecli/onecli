"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { provisions } from "@/lib/api";

/**
 * Redeeming a provision claim link (EE member provisioning). Not org-scoped:
 * the caller is not a member yet. No cache invalidation — the claim page
 * hands off with a full navigation, so the dashboard mounts fresh.
 */
export const useClaimProvision = () =>
  useMutation({
    mutationFn: (token: string) => provisions.claim(token),
    onError: (err) => toast.error(err.message),
  });
