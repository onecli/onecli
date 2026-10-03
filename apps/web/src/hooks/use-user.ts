"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { user } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/**
 * What deleting the account does to each of the user's organizations. Read
 * only while the delete dialog is open (`enabled`), and always fresh: the
 * dialog must never acknowledge a stale list, because the server destroys
 * exactly what it lists.
 */
export const useAccountDeletionImpact = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.user.deletionImpact(),
    queryFn: user.deletionImpact,
    enabled,
    staleTime: 0,
    gcTime: 0,
  });

/**
 * Delete the account. Nothing to invalidate: the user is signed out on
 * success and every cache entry dies with the session. Refusals (the 409 for
 * an owned org with other members) surface through `error` for the dialog to
 * render inline — the caller owns the toast, as it owns the sign-out.
 */
export const useDeleteAccount = () => useMutation({ mutationFn: user.remove });
