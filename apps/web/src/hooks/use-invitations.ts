"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invitations } from "@/lib/api";
import type { CreateInvitationInput } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/**
 * Team invitations. Free on every edition — an unlicensed self-host invites
 * its team the same way cloud does; only the seat cap differs, and that is
 * enforced server-side.
 */
export const useInvitations = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.invitations.list(),
    queryFn: () => invitations.list(),
    enabled,
    // Admin-only: a non-admin gets a deterministic 403, which is an answer,
    // not a transient failure.
    retry: false,
  });

/**
 * Creating an invitation returns its token so the caller can show a copyable
 * join link — the delivery path that works with no email configured at all.
 * Deliberately no success toast here: the dialog renders the link instead, and
 * a toast saying "sent" is exactly the false claim this flow existed to stop.
 */
export const useCreateInvitation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInvitationInput) => invitations.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invitations.all() });
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useCancelInvitation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) => invitations.cancel(invitationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invitations.all() });
      toast.success("Invitation cancelled");
    },
    onError: (err) => toast.error(err.message),
  });
};

/** Redeeming an invitation. Not org-scoped: the caller is not a member yet. */
export const useAcceptInvitation = () =>
  useMutation({
    mutationFn: (token: string) => invitations.accept(token),
    onError: (err) => toast.error(err.message),
  });
