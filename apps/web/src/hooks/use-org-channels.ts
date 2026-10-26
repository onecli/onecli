"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { channels } from "@/lib/api";
import type {
  ChannelProvider,
  ChannelUserLink,
  OrgChannelsView,
} from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { listItem, patchItem, throughField } from "@/lib/api/optimistic";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";

// Headless mutations (the use-app-config convention) — the org settings cards
// own the toasts (the instant user-link remove says its own outcome: its row
// is gone by then). No gateway-cache involvement: the gateway reads none of
// the channel tables, deliberately.

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

/** Every hosted agent in the org, by workspace, with its Slack state: the
 * Channels page's one-click list. Mounted only once the workspace is
 * connected (the section gates it), so no `enabled` flag. */
export const useOrgChannelAgents = (provider: ChannelProvider) =>
  useQuery({
    queryKey: queryKeys.channels.orgAgents(provider),
    queryFn: () => channels.orgAgents(provider),
    // The install finishes in Slack's popup; refetch on return to the tab.
    staleTime: 0,
  });

/** One-click "Add to Slack" from the org page: the agent's guided create,
 * scoped to the agent's own workspace. Headless; the row owns the popup. */
export const useAttachAgentFromOrg = (provider: ChannelProvider) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceId,
      agentId,
    }: {
      workspaceId: string;
      agentId: string;
    }) => channels.attachInWorkspace(workspaceId, agentId, provider),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
    },
  });
};

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
    // Returned: the form closes onto a table that already lists the link.
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() }),
  });
};

/** Remove a Slack ↔ OneCLI user link, instantly: the row leaves on click;
 * the confirmation follows the server, and a failure puts the row back. */
export const useRemoveChannelUserLink = () =>
  useOptimisticMutation<void, { provider: ChannelProvider; linkId: string }>({
    family: "channel-user-links",
    itemKey: ({ linkId }) => `channel-user-link:${linkId}`,
    write: ({ provider, linkId }) => channels.removeUserLink(provider, linkId),
    apply: (qc, { linkId }) =>
      patchItem(
        qc,
        queryKeys.channels.org(),
        throughField<OrgChannelsView, "userLinks", ChannelUserLink>(
          "userLinks",
          listItem((l) => l.id === linkId),
        ),
        () => undefined,
      ),
    succeeded: () => toast.success("Link removed"),
    refresh: (qc) =>
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() }),
    failure: () => "Couldn't remove the link",
  });

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

/** Finish an agent's own app install that began in Slack. A match spends the
 * single-use code (a miss leaves it for the shared-app inspect), so the
 * caller fires it once. */
export const useFinishAgentInstall = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      provider: ChannelProvider;
      code: string;
      organizationId: string;
    }) =>
      channels.finishAgentInstall(
        input.provider,
        input.code,
        input.organizationId,
      ),
    onSuccess: (result) => {
      if (result.agent) {
        qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      }
    },
  });
};

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
