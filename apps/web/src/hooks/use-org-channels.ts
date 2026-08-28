"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { channels } from "@/lib/api";
import type { ChannelProvider } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// Headless mutations (the use-app-config convention) — the org settings cards
// own the toasts. No gateway-cache involvement: the gateway reads none of the
// channel tables, deliberately.

/** Everything the org Channels settings page renders, in one call:
 * integrations, user links, adapter liveness. */
export const useOrgChannels = () =>
  useQuery({
    queryKey: queryKeys.channels.org(),
    queryFn: channels.orgView,
  });

/** Connect or refresh the org automation credential (Slack: the
 * app-configuration refresh token — validated server-side by rotating it). */
export const useConnectChannelIntegration = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      provider,
      credential,
    }: {
      provider: ChannelProvider;
      credential: string;
    }) => channels.putCredentials(provider, credential),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    },
  });
};

export const useDisconnectChannelIntegration = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: ChannelProvider) => channels.disconnect(provider),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    },
  });
};

export const useAddChannelUserLink = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      provider,
      externalUserId,
      userId,
    }: {
      provider: ChannelProvider;
      externalUserId: string;
      userId: string;
    }) => channels.addUserLink(provider, { externalUserId, userId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    },
  });
};

export const useRemoveChannelUserLink = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      provider,
      linkId,
    }: {
      provider: ChannelProvider;
      linkId: string;
    }) => channels.removeUserLink(provider, linkId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    },
  });
};
