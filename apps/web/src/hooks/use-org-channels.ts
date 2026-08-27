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
    // Installs and uninstalls complete in ANOTHER tab (Slack's consent
    // page); the 30s global staleTime would swallow the focus refetch.
    staleTime: 0,
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

/** Mint the "Add to Slack" consent URL — the caller opens it. Side-effect
 * free server-side, so no invalidation is owed on success. */
export const useStartSharedInstall = () =>
  useMutation({
    mutationFn: (provider: ChannelProvider) =>
      channels.startSharedInstall(provider),
  });

/** Exchange a directory-install code and NAME the workspace it came from —
 * binds nothing (the informed-consent half of the two-step finish). */
export const useInspectSharedInstall = () =>
  useMutation({
    mutationFn: (input: {
      provider: ChannelProvider;
      code: string;
      organizationId: string;
    }) =>
      channels.inspectSharedInstall(
        input.provider,
        input.code,
        input.organizationId,
      ),
  });

/** Bind an inspected workspace claim to the named org. */
export const useFinishSharedInstall = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      provider: ChannelProvider;
      claim: string;
      organizationId: string;
    }) =>
      channels.finishSharedInstall(
        input.provider,
        input.claim,
        input.organizationId,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    },
  });
};

/** Disconnect the org's shared-app install. */
export const useDisconnectSharedInstall = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: ChannelProvider) =>
      channels.disconnectSharedInstall(provider),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    },
  });
};
